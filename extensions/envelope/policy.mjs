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
  const start = text.indexOf(START);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).trimEnd();
}

export function composePolicy(prompt, enabled) {
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) return null;
  const parts = Array.isArray(prompt) ? prompt : [prompt];
  const present = parts.some((p) => typeof p === 'string' && p.includes(START));
  if (enabled && present) return { systemPrompt: prompt };
  if (!enabled && !present) return null;
  const clean = parts.map((s) => typeof s === 'string' ? dropStale(s) : s);
  if (enabled) clean.push(BODY);
  return { systemPrompt: Array.isArray(prompt) ? clean : clean.join('\n\n') };
}
