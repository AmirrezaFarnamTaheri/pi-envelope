/** Bounded, in-memory fragment ranking of already indexed raw output.
 * The canonical full body and FTS index are unchanged. No embeddings or LLM. */
const WORDS = /[\p{L}\p{N}_]+/gu;
function terms(text) {return [...new Set(String(text||'').toLowerCase().match(WORDS)?.slice(0,8)||[])];}
function grams(text){
  const chars=Array.from(text.toLowerCase());
  const result=new Set();
  for(let i=0;i+2<chars.length;i++)result.add(chars.slice(i,i+3).join(''));
  return result;
}

export function splitOutputSections(text,{maxChars=1400}={}) {
  if(typeof text!=='string')throw new TypeError('output must be text');
  if(!Number.isInteger(maxChars)||maxChars<80||maxChars>4000)throw new RangeError('maxChars must be 80..4000');
  const lines=text.split(/\r\n|\n|\r/);
  const chunks=[];
  let current=[],start=1,length=0;
  function flush(end){
    if(!current.length)return;
    chunks.push({lineStart:start,lineEnd:end,text:current.join('\n')});
    current=[];length=0;
  }
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const isHeading=/^\s*#{1,6}\s+\S/.test(line);
    if(current.length && (isHeading || length+line.length+1 > maxChars)){
      flush(i);start=i+1;
    }
    if(!current.length)start=i+1;
    current.push(line);length+=line.length+1;
  }
  flush(lines.length);
  return chunks;
}

export function rankFragments(chunks,query,{limit=10,maxPreviewChars=320}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>25)throw new RangeError('limit must be 1..25');
  if(!Number.isInteger(maxPreviewChars)||maxPreviewChars<100||maxPreviewChars>500)throw new RangeError('maxPreviewChars must be 100..500');
  const words=terms(query);
  if(!words.length)return [];
  const candidates=[];
  for(const part of chunks){
    const value=part.text.toLowerCase();
    if(!words.every(word=>value.includes(word)))continue;
    const lexical=words.reduce((score,word)=>score+(value.split(word).length-1),0);
    const needle=grams(words.join(' ')),haystack=grams(value.slice(0,4000));
    let overlap=0;for(const gram of needle)if(haystack.has(gram))overlap++;
    candidates.push({...part,lexical,overlap});
  }
  const lex=[...candidates].sort((a,b)=>b.lexical-a.lexical||a.lineStart-b.lineStart);
  const tri=[...candidates].sort((a,b)=>b.overlap-a.overlap||a.lineStart-b.lineStart);
  const lexRank=new Map(lex.map((x,i)=>[x,i+1]));
  const triRank=new Map(tri.map((x,i)=>[x,i+1]));
  return candidates.map(part=>({part,rank:1/(60+lexRank.get(part))+1/(60+triRank.get(part))}))
    .sort((a,b)=>b.rank-a.rank||a.part.lineStart-b.part.lineStart)
    .slice(0,limit).map(({part})=>({
      lineStart:part.lineStart,lineEnd:part.lineEnd,
      preview:part.text.length>maxPreviewChars?`${part.text.slice(0,maxPreviewChars)}…`:part.text,
      previewTruncated:part.text.length>maxPreviewChars
    }));
}
