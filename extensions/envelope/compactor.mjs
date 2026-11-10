/**
 * Conservative, reversible result reduction from the original output bytes.
 * Only complete recognized success/progress records are discarded. Retained
 * records (particularly edit anchors and diagnostic lines) are never changed,
 * including their ANSI sequences and original line endings.
 *
 * Pattern-level adaptation of MasuRii/pi-rtk-optimizer and JayPokale/Chisle;
 * no upstream implementation is copied. Envelope keeps one bash-result owner and
 * persists the exact raw output in its existing OutputStore before returning.
 */

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const ANCHOR = /(?:\[L\d+\]|\b[0-9a-f]{7,}[:|]\d+\b|(?:^|\n|\r)\s*\d+\s*(?:#\s*[\w-]{2,32}:|:\s*[\w-]{1,32}\||[a-z]{2}\||\|\s*(?:[0-9a-f]{7,}|\S+)))/im;
const PASS_LINE = /^\s*(?:[✓✔]\s+|ok\s+\d+\s+-\s+|PASS\s+\S+)/iu;
const TEST_SUMMARY = /(?:^\s*(?:Test (?:Files|Suites)|Tests?:|Tests\s+\d+|Duration\s|Ran \d+ tests?|# (?:tests|pass|fail)|All tests passed|PASS\s*$)|\b(?:warning|error|failed|FAIL)\b)/i;
const BUILD_PROGRESS = /^\s*(?:Compiling module \d+\s*\/\s*\d+|Building module \d+\s*\/\s*\d+|transforming \(\d+\)|transformed \d+ modules|[✓✔]\s*\d+ modules transformed)/i;
const GIT_FILE = /^\s*(?:modified:|new file:|deleted:|renamed:|copied:|typechange:|\?\?|[MADRCUT?!]{1,2}\s+)(?:\s+.+)?$/;
const DIAGNOSTIC = /\b(?:warning|error|failed|failure|fatal|timeout|aborted|cancelled|canceled|panic|exception)\b/i;

function unchanged(text, category = 'other') {
  return { changed:false, text, category, originalBytes:Buffer.byteLength(text),
    renderedBytes:Buffer.byteLength(text), omittedLines:0 };
}

/** Recognize the existing Pi anchors and read/hashline formats; no rewriting. */
export function isAnchorSensitive(text) {
  return ANCHOR.test(text) || /\bhashline\b|\bedit anchor\b/i.test(text);
}

function isMachineReadable(text) {
  const first = text.trimStart();
  if (!first.startsWith('{') && !first.startsWith('[')) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch { return false; }
}

/** Split without losing CRLF, isolated CR, terminal LF, escape codes or bytes. */
function lineRecords(text) {
  const segments = text.split(/(\r\n|\n|\r)/);
  const records = [];
  for (let i = 0; i < segments.length; i += 2) {
    const body = segments[i] ?? '';
    const ending = segments[i + 1] ?? '';
    if (i === segments.length - 1 && body === '' && i > 0) continue;
    records.push({ body, ending, visible:body.replace(ANSI, '') });
  }
  return records;
}

function categoryOf(records) {
  const lines = records.map(record => record.visible);
  const probe = lines.slice(0, 16).join('\n');
  if (/^(?:On branch |##\s+\S+)|Changes (?:not staged|to be committed)|Untracked files:/m.test(probe)) return 'git';
  if (/(?:Test Files\s+\d+|Tests\s+\d+|Test Suites:|^TAP version |^# tests |^RUN v\d+|^\s*[✓✔]\s+.+(?:tests?|spec))/mi.test(lines.join('\n'))) return 'tests';
  if (/\b(?:Compiling module|Building module|modules transformed|Build finished|Build complete)\b/i.test(probe)) return 'build';
  return 'other';
}

/** Deletions, renames and unmerged Git index states are actionable, not noise. */
function isCriticalGitChange(line) {
  if (/^\s*(?:deleted:|renamed:|copied:|typechange:)/i.test(line)) return true;
  const code = line.match(/^\s*([MADRCUT?!]{1,2})\s+/)?.[1];
  return Boolean(code && (/[UDRCT]/.test(code) || code === 'AA'));
}

function isProtected(record) {
  return isAnchorSensitive(record.visible) || isAnchorSensitive(record.body) || DIAGNOSTIC.test(record.visible);
}

/** @param {string} text @param {{ minBytes?:number,maxChars?:number,minSavingsRatio?:number }} options */
export function compactOutput(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('output must be text');
  const minBytes = options.minBytes ?? 1200;
  const maxBytes = options.maxChars ?? 12000; // Historical setting name; measured as UTF-8 bytes.
  const minSavingsRatio = options.minSavingsRatio ?? 0.2;
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes < minBytes || isMachineReadable(text)) return unchanged(text);

  const records = lineRecords(text);
  const category = categoryOf(records);
  if (category === 'other') return unchanged(text, category);
  const changeCount = category === 'git' ? records.filter(r=>GIT_FILE.test(r.visible)).length : 0;
  if (category === 'git' && changeCount <= 16) return unchanged(text, category);

  let skipped = 0;
  let keptChanges = 0;
  const kept = [];
  for (const record of records) {
    const visible = record.visible;
    let omit = false;
    if (!isProtected(record)) {
      if (category === 'tests') omit = PASS_LINE.test(visible) && !TEST_SUMMARY.test(visible);
      else if (category === 'build') omit = BUILD_PROGRESS.test(visible);
      else if (GIT_FILE.test(visible)) {
        if (isCriticalGitChange(visible)) { /* retain all destructive and unmerged changes */ }
        else if (keptChanges >= 10) omit = true;
        else keptChanges++;
      }
    }
    if (omit) skipped++;
    else kept.push(record);
  }
  if (!skipped) return unchanged(text, category);
  const note = category === 'git'
    ? `[envelope: ${changeCount} change entries; ${skipped} additional entries omitted; exact original available via recall]`
    : `[envelope: ${skipped} ${category === 'tests' ? 'repetitive test' : 'build progress'} lines omitted; exact original available via recall]`;
  const retained = kept.map(r=>r.body+r.ending).join('');
  const separator = records.find(r=>r.ending)?.ending || '\n';
  const reduced = `${retained}${retained.endsWith('\n') || retained.endsWith('\r') ? '' : separator}${note}`;
  const renderedBytes = Buffer.byteLength(reduced);
  if (renderedBytes >= originalBytes * (1 - minSavingsRatio) || renderedBytes > maxBytes) {
    return unchanged(text, category);
  }
  return { changed:true, text:reduced, category, originalBytes, renderedBytes, omittedLines:skipped };
}
