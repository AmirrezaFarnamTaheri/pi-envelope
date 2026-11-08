"""Parse untrusted Python source through ast; never import or execute project code."""
import ast
import json
import sys

MAX_CALLS = 200


def parse(record):
    path = record['path']
    source = record['content']
    report = {'path': path, 'symbols': [], 'imports': [], 'diagnostics': [],
              'declarations': [], 'bindings': [], 'calls': [], 'omittedCalls': 0}
    lines = source.splitlines()
    try:
        root = ast.parse(source, filename=path, type_comments=True)
    except (SyntaxError, ValueError, TypeError) as err:
        report['diagnostics'].append({
            'line': max(1, getattr(err, 'lineno', 1) or 1),
            'column': max(1, getattr(err, 'offset', 1) or 1),
            'code': 'PY_SYNTAX',
            'message': str(getattr(err, 'msg', err))[:300],
        })
        return report

    def column(node):
        # Python AST columns are UTF-8 byte offsets; tool columns use UTF-16.
        number = getattr(node, 'lineno', 0)
        data = lines[number - 1] if 0 < number <= len(lines) else ''
        prefix = data.encode('utf-8')[:getattr(node, 'col_offset', 0)]
        return 1 + len(prefix.decode('utf-8', errors='ignore').encode('utf-16-le')) // 2

    def visit(node, container=''):
        if isinstance(node, ast.ClassDef):
            report['symbols'].append({'path': path, 'name': node.name, 'kind': 'class',
                                      'container': '', 'line': node.lineno, 'column': column(node)})
            for child in ast.iter_child_nodes(node):
                visit(child, node.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            report['symbols'].append({'path': path, 'name': node.name, 'kind': 'method' if container else 'function',
                                      'container': container, 'line': node.lineno, 'column': column(node)})
            for child in ast.iter_child_nodes(node):
                visit(child, '')
        elif isinstance(node, ast.Import):
            for item in node.names:
                report['imports'].append(item.name)
        elif isinstance(node, ast.ImportFrom):
            base = '.' * node.level + (node.module or '')
            if base and base.strip('.') and base not in report['imports']:
                report['imports'].append(base)
            for item in node.names:
                if item.name != '*':
                    ref = base + ('' if not base or base.endswith('.') else '.') + item.name
                    report['imports'].append(ref)
        else:
            for child in ast.iter_child_nodes(node):
                visit(child, container)

    visit(root)
    report['imports'] = list(dict.fromkeys(report['imports']))

    for item in root.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            report['declarations'].append({'name': item.name[:128], 'line': item.lineno, 'exported': True})
        elif isinstance(item, ast.ImportFrom):
            base = '.' * item.level + (item.module or '')
            for alias in item.names:
                if alias.name != '*' and base:
                    report['bindings'].append({'kind': 'named', 'local': (alias.asname or alias.name)[:128],
                                               'imported': alias.name[:128], 'spec': base})

    # Even a direct call can be shadowed by a parameter, assignment or nested definition.
    # Any uncertain rebinding produces *unresolved* evidence, not a false positive.
    module_assignments = set()
    for item in root.body:
        if isinstance(item, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            for sub in ast.walk(item):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                    module_assignments.add(sub.id)

    def function_calls(fn, name):
        local = set(module_assignments)
        args = fn.args
        for arg in args.posonlyargs + args.args + args.kwonlyargs:
            local.add(arg.arg)
        for arg in (args.vararg, args.kwarg):
            if arg is not None:
                local.add(arg.arg)

        class LocalBinder(ast.NodeVisitor):
            def visit_FunctionDef(self, node):
                local.add(node.name)
            visit_AsyncFunctionDef = visit_FunctionDef
            def visit_ClassDef(self, node):
                local.add(node.name)
            def visit_Lambda(self, node):
                return
            def visit_Name(self, node):
                if isinstance(node.ctx, ast.Store):
                    local.add(node.id)
            def visit_Import(self, node):
                for alias in node.names:
                    local.add(alias.asname or alias.name.split('.')[0])
            def visit_ImportFrom(self, node):
                for alias in node.names:
                    local.add(alias.asname or alias.name)
        binder = LocalBinder()
        for statement in fn.body:
            binder.visit(statement)

        class CallVisitor(ast.NodeVisitor):
            def visit_FunctionDef(self, node):
                return
            visit_AsyncFunctionDef = visit_FunctionDef
            def visit_Lambda(self, node):
                return
            def visit_ClassDef(self, node):
                return
            def visit_Call(self, node):
                form = None
                receiver = ''
                if isinstance(node.func, ast.Name):
                    form, callee = 'direct', node.func.id
                elif isinstance(node.func, ast.Attribute):
                    form, callee = 'member', node.func.attr
                    if isinstance(node.func.value, ast.Name):
                        receiver = node.func.value.id
                if form:
                    if len(report['calls']) >= MAX_CALLS:
                        report['omittedCalls'] += 1
                    else:
                        report['calls'].append({'name': callee[:128], 'form': form, 'receiver': receiver[:128],
                                                'caller': {'name': name[:128], 'line': fn.lineno},
                                                'line': node.func.lineno, 'column': column(node.func),
                                                'shadowed': (callee if form == 'direct' else receiver) in local})
                self.generic_visit(node)
        finder = CallVisitor()
        for statement in fn.body:
            finder.visit(statement)

    for item in root.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function_calls(item, item.name)
        if isinstance(item, ast.ClassDef):
            for member in item.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function_calls(member, item.name + '.' + member.name)

    return report


def main():
    payload = json.load(sys.stdin)
    records = [parse(record) for record in payload['files']]
    json.dump({'records': records}, sys.stdout, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
