// Parse untrusted Go text from stdin using go/parser; never compile or execute indexed code.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"os"
	pathpkg "path"
	"strconv"
	"strings"
)

const maxCalls = 200

type inputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type request struct {
	Files []inputFile `json:"files"`
}
type symbol struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Container string `json:"container"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
}
type diagnostic struct {
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type declaration struct {
	Name     string `json:"name"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
}
type binding struct {
	Kind     string `json:"kind"`
	Local    string `json:"local"`
	Spec     string `json:"spec"`
	Explicit bool   `json:"explicit"`
}
type caller struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}
type call struct {
	Name     string `json:"name"`
	Form     string `json:"form"`
	Receiver string `json:"receiver"`
	Caller   caller `json:"caller"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Shadowed bool   `json:"shadowed"`
}
type record struct {
	Path         string        `json:"path"`
	Symbols      []symbol      `json:"symbols"`
	Imports      []string      `json:"imports"`
	Diagnostics  []diagnostic  `json:"diagnostics"`
	Package      string        `json:"package"`
	Declarations []declaration `json:"declarations"`
	Bindings     []binding     `json:"bindings"`
	Calls        []call        `json:"calls"`
	OmittedCalls int           `json:"omittedCalls"`
}

func receiver(t ast.Expr) string {
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return receiver(v.X)
	case *ast.IndexExpr:
		return receiver(v.X)
	case *ast.IndexListExpr:
		return receiver(v.X)
	}
	return ""
}

func utf16Column(lines []string, pos token.Position) int {
	if pos.Line < 1 || pos.Line > len(lines) || pos.Column < 1 {
		return pos.Column
	}
	line := lines[pos.Line-1]
	end := pos.Column - 1
	if end > len(line) {
		end = len(line)
	}
	units := 0
	for _, r := range line[:end] {
		if r > 0xffff {
			units += 2
		} else {
			units++
		}
	}
	return units + 1
}

func bindNames(expr ast.Expr, shadow map[string]bool) {
	switch v := expr.(type) {
	case *ast.Ident:
		if v.Name != "_" {
			shadow[v.Name] = true
		}
	case *ast.StarExpr:
		bindNames(v.X, shadow)
	case *ast.ParenExpr:
		bindNames(v.X, shadow)
	}
}

func parse(in inputFile) record {
	r := record{Path: in.Path, Symbols: []symbol{}, Imports: []string{}, Diagnostics: []diagnostic{},
		Declarations: []declaration{}, Bindings: []binding{}, Calls: []call{}}
	lines := strings.Split(in.Content, "\n")
	set := token.NewFileSet()
	file, err := parser.ParseFile(set, in.Path, in.Content, parser.AllErrors|parser.ParseComments)
	if err != nil {
		if list, ok := err.(scanner.ErrorList); ok {
			for _, item := range list {
				if len(r.Diagnostics) >= 30 {
					break
				}
				r.Diagnostics = append(r.Diagnostics, diagnostic{Line: item.Pos.Line, Column: utf16Column(lines, item.Pos), Code: "GO_SYNTAX", Message: item.Msg})
			}
		} else {
			r.Diagnostics = append(r.Diagnostics, diagnostic{Line: 1, Column: 1, Code: "GO_SYNTAX", Message: err.Error()})
		}
		return r
	}
	r.Package = file.Name.Name
	for _, item := range file.Imports {
		value, err := strconv.Unquote(item.Path.Value)
		if err != nil {
			continue
		}
		r.Imports = append(r.Imports, value)
		alias, explicit := pathpkg.Base(value), false
		if item.Name != nil {
			alias, explicit = item.Name.Name, true
		}
		if alias != "_" && alias != "." && alias != "" {
			r.Bindings = append(r.Bindings, binding{Kind: "package", Local: alias, Spec: value, Explicit: explicit})
		}
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			kind, owner := "function", ""
			if d.Recv != nil && len(d.Recv.List) > 0 {
				kind = "method"
				owner = receiver(d.Recv.List[0].Type)
			}
			pos := set.Position(d.Name.Pos())
			r.Symbols = append(r.Symbols, symbol{Path: in.Path, Name: d.Name.Name, Kind: kind, Container: owner, Line: pos.Line, Column: utf16Column(lines, pos)})
			if d.Recv == nil {
				r.Declarations = append(r.Declarations, declaration{Name: d.Name.Name, Line: pos.Line, Exported: ast.IsExported(d.Name.Name)})
			}
			if d.Body == nil {
				continue
			}
			shadow := make(map[string]bool)
			addFields := func(fields *ast.FieldList) {
				if fields != nil {
					for _, field := range fields.List {
						for _, name := range field.Names {
							if name.Name != "_" {
								shadow[name.Name] = true
							}
						}
					}
				}
			}
			addFields(d.Type.Params)
			addFields(d.Recv)
			ast.Inspect(d.Body, func(node ast.Node) bool {
				switch v := node.(type) {
				case *ast.FuncLit:
					return false
				case *ast.AssignStmt:
					for _, x := range v.Lhs {
						bindNames(x, shadow)
					}
				case *ast.RangeStmt:
					if v.Key != nil {
						bindNames(v.Key, shadow)
					}
					if v.Value != nil {
						bindNames(v.Value, shadow)
					}
				case *ast.ValueSpec:
					for _, n := range v.Names {
						shadow[n.Name] = true
					}
				}
				return true
			})
			callerName := d.Name.Name
			if owner != "" {
				callerName = owner + "." + callerName
			}
			ast.Inspect(d.Body, func(node ast.Node) bool {
				if _, ok := node.(*ast.FuncLit); ok {
					return false
				}
				expr, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				form, callee, receiverName := "", "", ""
				var start ast.Expr
				switch fun := expr.Fun.(type) {
				case *ast.Ident:
					form, callee, start = "direct", fun.Name, fun
				case *ast.SelectorExpr:
					form, callee, start = "member", fun.Sel.Name, fun
					if x, yes := fun.X.(*ast.Ident); yes {
						receiverName = x.Name
					}
				}
				if form == "" {
					return true
				}
				if len(r.Calls) >= maxCalls {
					r.OmittedCalls++
					return true
				}
				pos := set.Position(start.Pos())
				check := callee
				if form == "member" {
					check = receiverName
				}
				r.Calls = append(r.Calls, call{Name: callee, Form: form, Receiver: receiverName,
					Caller: caller{Name: callerName, Line: posLine(set, d.Name.Pos())}, Line: pos.Line,
					Column: utf16Column(lines, pos), Shadowed: shadow[check]})
				return true
			})
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				if t, ok := spec.(*ast.TypeSpec); ok {
					kind := "type"
					switch t.Type.(type) {
					case *ast.StructType:
						kind = "struct"
					case *ast.InterfaceType:
						kind = "interface"
					}
					pos := set.Position(t.Name.Pos())
					r.Symbols = append(r.Symbols, symbol{Path: in.Path, Name: t.Name.Name, Kind: kind, Line: pos.Line, Column: utf16Column(lines, pos)})
				}
				if v, ok := spec.(*ast.ValueSpec); ok {
					for _, n := range v.Names {
						pos := set.Position(n.Pos())
						r.Symbols = append(r.Symbols, symbol{Path: in.Path, Name: n.Name, Kind: "variable", Line: pos.Line, Column: utf16Column(lines, pos)})
					}
				}
			}
		}
	}
	return r
}

func posLine(set *token.FileSet, pos token.Pos) int { return set.Position(pos).Line }

func main() {
	decoder := json.NewDecoder(os.Stdin)
	var in request
	if err := decoder.Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "invalid request")
		os.Exit(2)
	}
	if len(in.Files) > 1000 {
		fmt.Fprintln(os.Stderr, "too many files")
		os.Exit(2)
	}
	out := struct {
		Records []record `json:"records"`
	}{Records: make([]record, 0, len(in.Files))}
	for _, entry := range in.Files {
		if strings.ContainsRune(entry.Path, '\x00') {
			fmt.Fprintln(os.Stderr, "invalid path")
			os.Exit(2)
		}
		out.Records = append(out.Records, parse(entry))
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(out); err != nil {
		os.Exit(2)
	}
}
