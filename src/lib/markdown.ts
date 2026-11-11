// Small, safe markdown renderer. Every piece of user text is HTML-escaped
// BEFORE any markup is added, so raw HTML in a post or lesson renders as text.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(raw: string): string {
  const codes: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  const keep = (html: string) => {
    links.push(html);
    return `\u0001${links.length - 1}\u0001`;
  };
  // [text](https://url) only http and https.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => keep(`<a href="${u}" target="_blank" rel="noopener nofollow ugc">${t}</a>`));
  // Bare URLs.
  s = s.replace(/https?:\/\/[^\s<]+/g, (u) => {
    const m = u.match(/^(.*?)([.,;:!?)]*)$/)!;
    return keep(`<a href="${m[1]}" target="_blank" rel="noopener nofollow ugc">${m[1]}</a>`) + m[2];
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return s;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      const label = lang === 'prompt' ? 'Prompt' : lang ? escapeHtml(lang) : 'Code';
      out.push(
        `<div class="codeblock${lang === 'prompt' ? ' prompt' : ''}"><div class="codebar"><span>${label}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length + 1; // # -> h2, keeps one h1 per page
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)![1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list) flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export function excerpt(src: string, n = 220): string {
  const t = src.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).trimEnd() + '...' : t;
}
