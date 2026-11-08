/** Verify that the pinned, bundled Tersio resource tree is actually present. */
import { existsSync, lstatSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function safeSubpath(base, name) {
  const full = resolve(base, name);
  if (!full.startsWith(base + sep)) throw new Error(`unsafe upstream resource: ${name}`);
  return full;
}

export function verifyUpstreamBundle(projectRoot, expected) {
  const errors=[];
  const root=resolve(projectRoot, 'node_modules/@krtclcdy/tersio');
  if (!existsSync(join(root,'package.json'))) {
    return { ok:false, errors:['Pinned Tersio dependency not installed. Run npm install before pi install .'] };
  }
  let actual;
  try { actual=JSON.parse(readFileSync(join(root,'package.json'),'utf8')); }
  catch (err) { return {ok:false,errors:[`Cannot read bundled Tersio package.json: ${err.message}`]}; }
  if (actual.version !== expected.version) errors.push(`Tersio version mismatch: expected ${expected.version}, got ${actual.version}`);
  for (const kind of ['extensions','skills']) {
    const found = actual.pi?.[kind] || [];
    if (JSON.stringify(found) !== JSON.stringify(expected.pi[kind])) {
      errors.push(`Tersio ${kind} manifest has drifted from pinned resources`);
    }
    for (const resource of expected.pi[kind]) {
      try {
        const location=safeSubpath(root, resource);
        if (!existsSync(location)) errors.push(`Missing ${kind} resource: ${resource}`);
        else {
          const canonical=realpathSync(location);
          const packageReal=realpathSync(root);
          if(!canonical.startsWith(packageReal+sep) || lstatSync(location).isSymbolicLink()){
            errors.push(`Unsafe symlink or escaping ${kind} resource: ${resource}`);
          } else if (kind==='skills' && !statSync(location).isDirectory()){
            errors.push(`Skill root is not a directory: ${resource}`);
          } else if (kind==='extensions' && !statSync(location).isFile()){
            errors.push(`Extension entrypoint is not a file: ${resource}`);
          }
        }
      } catch (err) { errors.push(err.message); }
    }
  }
  return {ok: errors.length===0,errors};
}

/** Verify that code tools can load the pinned TypeScript compiler, without evaluating project code. */
export function verifyAstParserBundle(projectRoot, expectedVersion) {
  const root=resolve(projectRoot,'node_modules/typescript');
  const packageFile=join(root,'package.json');
  if (!existsSync(packageFile)) return {ok:false,errors:['Pinned TypeScript AST parser is not installed. Run npm install before pi install .']};
  const errors=[];
  try {
    const info=JSON.parse(readFileSync(packageFile,'utf8'));
    if(info.version!==expectedVersion) errors.push(`TypeScript version mismatch: expected ${expectedVersion}, got ${info.version}`);
  } catch(err) {errors.push(`Cannot read TypeScript package.json: ${err.message}`);}
  if(!existsSync(join(root,'lib','typescript.js'))) errors.push('Missing TypeScript parser library: lib/typescript.js');
  return {ok:errors.length===0,errors};
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const projectRoot=dirname(dirname(scriptPath));
  const f=JSON.parse(readFileSync(join(projectRoot,'fixtures/tersio-pi-manifest.json'),'utf8'));
  const result=verifyUpstreamBundle(projectRoot,{version:f.version,pi:{extensions:f.extensions,skills:f.skills}});
  const manifest=JSON.parse(readFileSync(join(projectRoot,'package.json'),'utf8'));
  const parser=verifyAstParserBundle(projectRoot,manifest.dependencies.typescript);
  if(result.ok && parser.ok) console.log(`Tersio ${f.version}: all ${f.extensions.length} extension and ${f.skills.length} skill entries present; TypeScript ${manifest.dependencies.typescript} AST parser present.`);
  else {
    for(const error of [...result.errors,...parser.errors]) console.error(`FAIL: ${error}`);
    process.exitCode=1;
  }
}
