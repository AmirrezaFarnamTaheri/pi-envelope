/**
 * Optional policy composed from Chisle's minimal-work ladder, Ponytail's
 * smallest-diff rule and Caveman's answer-first guidance.
 * It adds no prompt tokens until explicitly enabled.
 */
const START = '<ENVELOPE_POLICY>';
const END = '</ENVELOPE_POLICY>';
const BODY = `${START}
Use concise, precise, answer-first prose. Omit filler, not facts, qualifications, or failure details.
Before implementing, understand the actual code. Prefer: no unnecessary change > reuse existing code > stdlib > existing dependencies > the smallest correct implementation.
No speculative abstractions, duplicate frameworks or unnecessary files. Preserve security checks, error handling, accessibility and tests.
Keep error text, code, paths, commands, numbers and negations exact. Report what was verified and what remains unverified.
${END}`;

function dropStale(text) {
  let out = text;
  for (;;) {
    const start = out.indexOf(START);
    if (start < 0) break;
    const end = out.indexOf(END, start);
    if (end < 0) {
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(end + END.length);
  }
  return out.trimEnd();
}

export function composePolicy(prompt, enabled) {
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) return null;
  const parts = Array.isArray(prompt) ? prompt : [prompt];
  const strings=parts.filter(p=>typeof p==='string');
  const count=(value,tag)=>value.split(tag).length-1;
  const starts=strings.reduce((n,p)=>n+count(p,START),0);
  const ends=strings.reduce((n,p)=>n+count(p,END),0);
  const hasAny=starts>0||ends>0;
  const wellFormed=strings.some(p=>p.indexOf(START)>=0&&p.indexOf(END)>p.indexOf(START));
  if (enabled && starts===1 && ends===1 && wellFormed) {
    return { systemPrompt: prompt };
  }
  if (!enabled && !hasAny) return null;
  const clean = parts
    .map((s) => typeof s === 'string' ? dropStale(s) : s)
    .filter((s) => typeof s !== 'string' || s.length > 0);
  if (enabled) clean.push(BODY);
  return { systemPrompt: Array.isArray(prompt) ? clean : clean.join('\n\n') };
}
