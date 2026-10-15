const ts = require(process.argv[2]);
const fs = require("fs"); const path = require("path");
const roots = process.argv.slice(3);
const files = [];
function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()){ if(!["node_modules","dist","__tests__","test-helpers"].includes(e.name)) walk(p);} else if(/\.tsx?$/.test(e.name)&&!/\.(test|spec)\.tsx?$/.test(e.name)) files.push(p);} }
roots.forEach(walk);
const out=[];
for(const f of files){
  const src=ts.createSourceFile(f,fs.readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true,f.endsWith("x")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  function name(n){ if(n.name&&n.name.getText) return n.name.getText(); if(n.parent&&ts.isVariableDeclaration(n.parent)) return n.parent.name.getText(); if(n.parent&&ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    if(n.parent&&ts.isCallExpression(n.parent)){ const c=n.parent.expression.getText().slice(0,40); return `<cb ${c}>`;} return "<anon>"; }
  function isFn(n){return ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessor(n);}
  function cx(fn){ let c=1; function v(n){ if(n!==fn&&isFn(n)) return; switch(n.kind){case ts.SyntaxKind.IfStatement:case ts.SyntaxKind.ForStatement:case ts.SyntaxKind.ForInStatement:case ts.SyntaxKind.ForOfStatement:case ts.SyntaxKind.WhileStatement:case ts.SyntaxKind.DoStatement:case ts.SyntaxKind.CaseClause:case ts.SyntaxKind.CatchClause:case ts.SyntaxKind.ConditionalExpression:c++;break;
    case ts.SyntaxKind.BinaryExpression:{const k=n.operatorToken.kind; if(k===ts.SyntaxKind.AmpersandAmpersandToken||k===ts.SyntaxKind.BarBarToken||k===ts.SyntaxKind.QuestionQuestionToken)c++;break;}} ts.forEachChild(n,v);} ts.forEachChild(fn,v); return c;}
  function visit(n){ if(isFn(n)&&n.body){ const s=src.getLineAndCharacterOfPosition(n.getStart()).line+1; const e=src.getLineAndCharacterOfPosition(n.end).line+1; out.push({file:f,fn:name(n),line:s,lines:e-s+1,cx:cx(n)});} ts.forEachChild(n,visit);}
  visit(src);
}
const mode=process.env.MODE||"cx";
const sorted=out.filter(o=>!(o.fn.startsWith("<cb")&&o.lines>200&&/describe|it\(/.test(o.fn))).sort((a,b)=>mode==="cx"?b.cx-a.cx:b.lines-a.lines).slice(0,+process.env.N||25);
for(const o of sorted) console.log(`| ${o.fn} | ${o.file}:${o.line} | ${o.lines} | ${o.cx} |`);
console.error("total fns",out.length,"cx>20:",out.filter(o=>o.cx>20).length,"cx>10:",out.filter(o=>o.cx>10).length);
