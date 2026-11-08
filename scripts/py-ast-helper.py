"""Parse untrusted Python source through ast; never import or execute project code."""
import ast
import json
import sys

MAX_CALLS = 200
MAX_MODULE_BINDINGS = 1000


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
        elif isinstance(item, ast.Import):
            for alias in item.names:
                # "import pkg.mod" binds "pkg", whereas "as m" binds the full module.
                # Deep attribute chains (pkg.mod.fn) remain explicitly unresolved.
                local = alias.asname or alias.name.split('.')[0]
                module = alias.name if alias.asname else local
                report['bindings'].append({'kind': 'namespace', 'local': local[:128], 'spec': module})
        elif isinstance(item, ast.ImportFrom):
            base = '.' * item.level + (item.module or '')
            for alias in item.names:
                if alias.name == '*' or not base:
                    continue  # Star imports and import-all bindings are deliberately opaque.
                if item.level and not item.module:
                    # "from . import mod as x" binds the module, not a function in __init__.
                    # The linker checks for a conflicting initializer declaration.
                    report['bindings'].append({'kind': 'namespace', 'local': (alias.asname or alias.name)[:128],
                                               'imported': alias.name[:128], 'spec': base + alias.name,
                                               'fromPackage': base})
                else:
                    report['bindings'].append({'kind': 'named', 'local': (alias.asname or alias.name)[:128],
                                               'imported': alias.name[:128], 'spec': base})

    # Any top-level assignment/rebinding can invalidate a module alias, even if
    # hidden in an if/for/with/try branch. Never scan the body of a nested scope.
    module_assignments = set()

    class TopLevelBinder(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            return
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self, node):
            module_assignments.add(node.name)
        def visit_Lambda(self, node):
            return
        def visit_Import(self, node):
            return  # Expected imports are checked for ambiguity by the linker.
        visit_ImportFrom = visit_Import
        def visit_Name(self, node):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                module_assignments.add(node.id)
        def visit_ExceptHandler(self, node):
            if node.name:
                module_assignments.add(node.name)
            self.generic_visit(node)
        def visit_MatchAs(self, node):
            if node.name:
                module_assignments.add(node.name)
            self.generic_visit(node)
        def visit_MatchStar(self, node):
            if node.name:
                module_assignments.add(node.name)
        def visit_MatchMapping(self, node):
            if node.rest:
                module_assignments.add(node.rest)
            self.generic_visit(node)

    binder = TopLevelBinder()
    for item in root.body:
        binder.visit(item)
    ordered = sorted(module_assignments)
    report['moduleAssigned'] = [name[:128] for name in ordered[:MAX_MODULE_BINDINGS]]
    report['moduleBindingsTruncated'] = len(ordered) > MAX_MODULE_BINDINGS

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
