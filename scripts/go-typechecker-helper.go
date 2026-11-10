// Offline go/types evidence from bounded stdin JSON: never builds, runs or imports project executables.
package main

import (
 "encoding/json"
 "fmt"
 "go/ast"
 "go/importer"
 "go/parser"
 "go/token"
 "go/types"
 "io"
 "os"
 "path"
 "regexp"
 "strings"
 "unicode/utf16"
)
const maxInput=2_400_000

type inputFile struct { Path string "json:\"path\""; Content string "json:\"content\"" }
type request struct { Files []inputFile "json:\"files\""; Path string "json:\"path\""; Action string "json:\"action\""; Line int "json:\"line\""; Column int "json:\"column\""; Limit int "json:\"limit\"" }
type diagnostic struct { Code string "json:\"code\""; Path string "json:\"path\""; Line int "json:\"line\""; Column int "json:\"column\""; Message string "json:\"message\"" }
type location struct { Path string "json:\"path\""; Line int "json:\"line\""; Column int "json:\"column\"" }
type response struct { Status string "json:\"status\""; Complete bool "json:\"complete\""; Reasons []string "json:\"reasons\""; Errors int "json:\"errors\""; Diagnostics []diagnostic "json:\"diagnostics\""; Symbol string "json:\"symbol,omitempty\""; Type string "json:\"type,omitempty\""; Declarations []location "json:\"declarations\""; Truncated bool "json:\"truncated\"" }
var literal=regexp.MustCompile("\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'")
func safeName(s string) bool {
 if s=="" || len(s)>256 || strings.ContainsAny(s,"\\\x00\r\n") || strings.HasPrefix(s,"/") {return false}
 for _,v:=range strings.Split(s,"/"){if v==""||v=="."||v==".."{return false}}
 return path.Clean(s)==s
}
func sanitize(s string) string {
 s=literal.ReplaceAllString(s,"[literal]")
 s=strings.ReplaceAll(strings.ReplaceAll(s,"\r"," "),"\n"," ")
 if len(s)>200{s=s[:200]}
 return s
}
func utf16Col(text string,byteCol int) int {
 if byteCol<1{return 0}; end:=byteCol-1;if end>len(text){end=len(text)}
 return len(utf16.Encode([]rune(text[:end])))+1
}
func fileLineUtf16Col(texts map[string]string,file string,line int,byteCol int) int {
 src,ok:=texts[file];if !ok||line<1||byteCol<1{if byteCol<1{return 0};return byteCol}
 lines:=strings.Split(src,"\n")
 if line>len(lines){return byteCol}
 return utf16Col(lines[line-1],byteCol)
}
func main(){
 raw,err:=io.ReadAll(io.LimitReader(os.Stdin,maxInput+1));if err!=nil||len(raw)>maxInput{os.Exit(2)}
 var input request
 if json.Unmarshal(raw,&input)!=nil || len(input.Files)==0 || len(input.Files)>64 || !safeName(input.Path) ||(input.Action!="symbol"&&input.Action!="diagnostics") || input.Limit<1||input.Limit>30 {os.Exit(2)}
 fset:=token.NewFileSet();astFiles:=make([]*ast.File,0,len(input.Files));texts:=map[string]string{};allPaths:=map[string]bool{};selectedFound:=false
 result:=response{Status:"diagnostics",Complete:true,Reasons:[]string{},Diagnostics:[]diagnostic{},Declarations:[]location{}}
 for _,f:=range input.Files {
  if !safeName(f.Path)||allPaths[f.Path]||len(f.Content)>300000 {os.Exit(2)}
  if path.Dir(f.Path)!=path.Dir(input.Path) {os.Exit(2)}
  allPaths[f.Path]=true;texts[f.Path]=f.Content
  if f.Path==input.Path{selectedFound=true}
  parsed,perr:=parser.ParseFile(fset,f.Path,f.Content,parser.AllErrors)
  if perr!=nil{
    result.Errors++;result.Complete=false;result.Reasons=append(result.Reasons,"go-parser-error")
    if len(result.Diagnostics)<input.Limit{result.Diagnostics=append(result.Diagnostics,diagnostic{Code:"GO_SYNTAX",Path:f.Path,Line:1,Column:1,Message:sanitize(perr.Error())})}
  }
  if parsed!=nil{astFiles=append(astFiles,parsed)}
 }
 if !selectedFound{os.Exit(2)}
 if len(astFiles)==0{output(result);return}
 info:=&types.Info{Defs:map[*ast.Ident]types.Object{},Uses:map[*ast.Ident]types.Object{},Types:map[ast.Expr]types.TypeAndValue{}}
 conf:=types.Config{Importer:importer.Default(),DisableUnusedImportCheck:true,Error:func(err error){
   result.Errors++;result.Complete=false
   msg:="Go typechecker error";point:=token.Position{}
   if e,ok:=err.(types.Error);ok{msg=e.Msg;point=fset.Position(e.Pos)}
   if strings.Contains(msg,"could not import")||strings.Contains(msg,"cannot find package"){result.Reasons=append(result.Reasons,"unresolved-package-import")}
   if len(result.Diagnostics)<input.Limit{p:=point.Filename;if !allPaths[p]{p=input.Path};col:=fileLineUtf16Col(texts,p,point.Line,point.Column);result.Diagnostics=append(result.Diagnostics,diagnostic{Code:"GO_TYPE",Path:p,Line:point.Line,Column:col,Message:sanitize(msg)})}
 }}
 pkgName:=astFiles[0].Name.Name
 for _,f:=range astFiles{if f.Name.Name!=pkgName{result.Complete=false;result.Reasons=append(result.Reasons,"mixed-go-package");result.Errors++;}}
 _,_=conf.Check(pkgName,fset,astFiles,info)
 if result.Errors>len(result.Diagnostics){result.Truncated=true}
 if result.Errors>0{result.Reasons=append(result.Reasons,"type-check-errors")}
 if input.Action=="symbol"{
  result.Status="unresolved"
  if input.Line<1||input.Column<1{os.Exit(2)}
  var chosen *ast.Ident
  for _,file:=range astFiles{
   if fset.Position(file.Pos()).Filename!=input.Path{continue}
   lines:=strings.Split(texts[input.Path],"\n")
   ast.Inspect(file,func(node ast.Node)bool{
    id,yes:=node.(*ast.Ident);if !yes{return true}
    pos:=fset.Position(id.Pos());if pos.Line!=input.Line||pos.Line<1||pos.Line>len(lines){return true}
    first:=utf16Col(lines[pos.Line-1],pos.Column)
    last:=first+len(utf16.Encode([]rune(id.Name)))
    if input.Column>=first&&input.Column<last{chosen=id}
    return true
   })
  }
  if chosen!=nil{
   object:=info.Uses[chosen];if object==nil{object=info.Defs[chosen]}
   if object!=nil{
    result.Status="resolved";result.Symbol=object.Name()
    if object.Type()!=nil{result.Type=object.Type().String()}
    loc:=fset.Position(object.Pos())
    if allPaths[loc.Filename]{col:=fileLineUtf16Col(texts,loc.Filename,loc.Line,loc.Column);result.Declarations=append(result.Declarations,location{Path:loc.Filename,Line:loc.Line,Column:col})}else{result.Complete=false;result.Reasons=append(result.Reasons,"declaration-outside-indexed-package")}
   }
  }
  if result.Status=="unresolved"{result.Complete=false;result.Reasons=append(result.Reasons,"no-compiler-symbol")}
 }
 if len(result.Reasons)>0{unique:=map[string]bool{};parts:=[]string{};for _,p:=range result.Reasons{if !unique[p]{unique[p]=true;parts=append(parts,p)}};result.Reasons=parts}
 output(result)
}
func output(result response){
 // json.Marshal does not execute user code. Never emit input file bodies.
 b,err:=json.Marshal(result);if err!=nil{os.Exit(2)};if len(b)>500000{os.Exit(2)}
 if _,err=fmt.Fprintln(os.Stdout,string(b));err!=nil{os.Exit(2)}
}
