// ==UserScript==
// @name         WPML Batch Translator Helper
// @namespace    everconvert
// @version      3.6
// @description  Batch-translate WPML Advanced Translation Editor segments via console / paste-in, or via Gemini/Claude/OpenAI. Preserves inline links & hidden markers.
// @match        https://*.ate.wpml.org/*
// @updateURL    https://raw.githubusercontent.com/EverConvert-Inc/translating/main/translator.user.js
// @downloadURL  https://raw.githubusercontent.com/EverConvert-Inc/translating/main/translator.user.js
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      api.openai.com
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

/*
  USAGE (from browser DevTools console, on an open Advanced Translation Editor page):

    wpml.extract()             // scrolls the list, captures every segment. Wait ~10s.
    wpml.read()                // prints [{i, tp, mk}, ...] you paste to your translator
    wpml.queue([                // enqueue translations. Fire-and-forget; drains in background.
      [0, "Traducción..."],
      [2, "Con {{0}} adentro.", ["texto del enlace"]],  // marker segment
      [58, "Con {{0}} adentro.", [null]],               // phone/link you DON'T translate
    ])
    wpml.prog()                // {done, total, active, queue, bad}
    wpml.verify()              // scroll-verify all segments. Wait ~15s.
    wpml.vprog()               // {done, total, missing, english, markerLost}
    wpml.fixMk(idx, N)         // patch a segment's mk length after MARKER_MISMATCH_expN_gotM

  AI USAGE — after wpml.extract(). Provider defaults to Gemini; switch to Claude via config():

    wpml.ai.config({ targetLang: "es", exclude: [137] })  // exclude = e.g. the Focus Keyword segment's index from read()
    wpml.ai.setKey("AIza...")              // once per browser profile; stored via Tampermonkey, never in this file
    wpml.ai.translate()                    // translates + validates batch 1 only, prints a preview, then waits
    wpml.ai.approve()                      // queues batch 1, then translates+queues the rest automatically
    wpml.ai.status()                       // {awaitingApproval, batchesDone, batchesTotal, translated, failed, lastError}
    wpml.ai.retryFailed()                  // re-attempt segments that failed validation after retries

  If a batch exhausts its network retries (e.g. persistent HTTP 429), approve() stops cleanly
  instead of throwing an unhandled rejection — check wpml.ai.status().lastError, fix the underlying
  issue (rate limit / quota / key), then call wpml.ai.approve() again to resume from that same
  batch. No need to refresh the page or re-run translate() — batchIndex/results are preserved.

    // To use Claude or OpenAI instead of Gemini:
    wpml.ai.config({ provider: "claude" })  // or "openai" — auto-fills that provider's default model; set targetLang/exclude same as above
    wpml.ai.setKey("sk-ant-...")            // or "sk-..." for OpenAI — stored separately per provider, switching never loses another provider's key

  Confirmed on live traffic: the default Gemini model below (set after the prior "gemini-2.5-flash
  no longer available to new users" 404) is exactly what Google's own API error recommended, and has
  since produced successful translations — no longer a guess.

  PANEL: a draggable floating panel is injected automatically (bottom-right by default, drag the
  header to move it, click "–" to collapse). The main view is deliberately minimal — API Keys,
  target language, and the "Translate Page" button, nothing else — with a "?" next to each section
  title revealing what it does instead of always-on paragraphs. Two clicks translate a whole page:
  "Translate Page" chains extract() -> auto-excludes any segment whose text matches
  /focus\s*keyword/i -> translate() batch 1, then pauses (same built-in review checkpoint
  translate() always stops at) and turns into "Approve & Finish" for the second click, which runs
  approve() -> waits for the segment queue to actually drain -> verify() -> shows the vprog()
  result. Everything else (manual exclude override, single-batch Translate, extract/verify/
  approve/retryFailed Actions, detailed Queue/Status, Error Log) lives behind an "Advanced"
  disclosure, closed by default — for troubleshooting or resuming a run the auto-flow stopped on,
  not for normal use. Browse-by-segment was removed from the panel entirely (it was extra UI for a
  one-time lookup) — wpml.read() in this console is still exactly how you'd find an index to hand
  the manual Exclude field. Every panel action, one-click or manual, calls the exact same functions
  listed here — nothing panel-only.

  Target language has a dropdown of common languages (defaults to Spanish) that just fills the text
  field next to it — type your own there for anything not listed. The provider dropdown now takes
  effect the instant you change it (previously only on Save, which silently kept the old provider
  active even after picking a different one and saving its key — a real incident, not a hypothetical).
  While an AI call is retrying a 429/5xx in the background (see retryDelayMs — up to ~105s of
  silence per batch otherwise), the panel now prints each retry attempt live instead of looking stuck.

  NOTES:
  - The list is virtualized. Keying is on data-at-segment-id (safe for duplicate text).
  - Clicking "+" auto-copies English into the field; the script always writes immediately.
  - Skip your final Focus Keyword segment (Rank Math) — it's not really a translation. Put its
    index (from wpml.read()) in wpml.ai.config({exclude:[...]}) before running wpml.ai.translate().
  - Never Save & Complete from here; verify first, then click it yourself.
*/

(function () {
  'use strict';
  // Unconditional startup log — proves the userscript actually executed on this page,
  // independent of the __wpmlHelperLoaded guard below. Check DevTools console for this line.
  try {
    console.log('%c[WPML Batch Translator]', 'color:#4CAF50;font-weight:bold',
      'script executing. version=' + (typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '?'),
      'grants=' + (typeof GM_info !== 'undefined' && GM_info.script ? JSON.stringify(GM_info.script.grant) : '?'));
  } catch (e) {
    console.log('[WPML Batch Translator] startup log failed:', e);
  }

  // GM_setValue/GM_xmlhttpRequest force Tampermonkey's sandbox, where `window` is no longer the
  // real page window — tinymce and the console-facing `wpml` object both need the real one.
  const gWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  console.log('%c[WPML Batch Translator]', 'color:#4CAF50;font-weight:bold',
    'sandboxed=' + (gWindow !== window), 'unsafeWindow available=' + (typeof unsafeWindow !== 'undefined'));

  if (gWindow.__wpmlHelperLoaded) {
    console.log('%c[WPML Batch Translator]', 'color:#FF9800;font-weight:bold',
      'already loaded on this page (guard tripped) — reload the page to pick up script changes.');
    return;
  }
  gWindow.__wpmlHelperLoaded = true;

  // ---------- core helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SETTLE = 420;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function scroller() {
    const it = document.querySelector('.AT-segment_list__segment_item');
    if (!it) return null;
    let p = it.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight - p.clientHeight > 100) return p;
      p = p.parentElement;
    }
    return null;
  }

  function textNode(item) {
    const o = item.querySelector('.AT-segment_list__original');
    if (!o) return null;
    return o.querySelector('[class*="SegmentTextContainer"]') || o;
  }

  function outerMarks(root) {
    const all = root.querySelectorAll('span[class*="ate-chip--marker"], span[data-segment]');
    const out = [];
    for (let i = 0; i < all.length; i++) {
      let nested = false;
      for (let j = 0; j < all.length; j++) {
        if (i !== j && all[j].contains(all[i])) { nested = true; break; }
      }
      if (!nested) out.push(all[i]);
    }
    return out;
  }

  // WPML sometimes groups a heading + its following paragraph into ONE segment (confirmed live
  // 2026-09-28, e.g. H2+P) — the SegmentTextContainer then has multiple block-level children
  // instead of holding text/marker spans directly. Only count DIRECT block children
  // (:scope >), never el.children generally: a normal single-paragraph segment has its text/marker
  // spans directly in the container (0 block children, or inline spans only) and must stay on the
  // old single-string path untouched. Markers are replaced with {{n}} globally across the whole
  // container BEFORE splitting into blocks, so numbering stays global across pieces as before.
  function tmpl(el) {
    const c = el.cloneNode(true);
    const outer = outerMarks(c);
    const marks = [];
    for (let k = 0; k < outer.length; k++) {
      marks.push({
        t: /marker-code|--x\b/.test(outer[k].className) ? 'x' : 'g',
        s: outer[k].textContent.trim(),
      });
      outer[k].replaceWith(document.createTextNode(' {{' + k + '}} '));
    }
    const blocks = c.querySelectorAll(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > p,:scope > li');
    if (blocks.length <= 1) {
      return { template: norm(c.textContent), marks, paraCount: 1 };
    }
    const template = Array.prototype.map.call(blocks, (b) => norm(b.textContent)).join(' [[P]] ');
    return { template, marks, paraCount: blocks.length };
  }

  // ---------- extraction from React fiber state (closed-segment "x" marker fix) ----------
  // Confirmed live 2026-10-08 (segment 9579081082): WPML hides "x" marker-code chips (phone/shortcode
  // placeholders) in the CLOSED segment column — they only render once that segment's editor is open.
  // tmpl()'s DOM read above therefore misses them whenever the editor is closed, which is the normal
  // extract()-time state for every segment. The full source, including hidden x markers, lives in
  // React state on the mounted (even closed) list-item component, reachable via its fiber.

  function decodeEntities(s) {
    const d = document.createElement('div');
    d.innerHTML = s || '';
    return d.textContent;
  }

  function findReactFiber(domNode) {
    const key = Object.keys(domNode).find((k) => k.indexOf('__reactFiber$') === 0);
    return key ? domNode[key] : null;
  }

  // Walks fiber.return up from the segment's list-item DOM node to the component fiber whose OWN
  // props identify this exact segment (memoizedProps.segmentId == id — confirmed live, currently
  // ~5 levels up as "SegmentItem", but matched by prop rather than a hard-coded depth since that
  // depth isn't guaranteed stable across WPML builds). Then searches that fiber's hook list for the
  // hook whose value exposes original_content — searched rather than index-assumed for the same
  // reason (confirmed live as hook #2 currently, but not asserted stable).
  function findSegmentFiberValue(domNode, id) {
    let fiber = findReactFiber(domNode);
    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && props.segmentId != null && String(props.segmentId) === String(id)) {
        let hook = fiber.memoizedState;
        for (let h = 0; hook && h < 30; h++, hook = hook.next) {
          const v = hook.memoizedState && hook.memoizedState.current && hook.memoizedState.current.value;
          if (v && typeof v.original_content === 'string') return v;
        }
        return null; // found the segment's own fiber but no hook matched the expected shape
      }
    }
    return null;
  }

  // original_content is XLIFF-ish: <g id="gid_0">translatable text</g> for a paired/translatable
  // inline run (links, etc. — matches the existing t:'g' semantics exactly), <x id="gid_1"/> (or
  // the paired <x id="...">...</x> form) for a non-translatable placeholder (phone/shortcode —
  // matches t:'x'). gid is kept on each mark so doOne() can match it to the editor's own
  // data-segment="gid_N" chip attribute instead of assuming DOM/array order. k0 is always 0 here —
  // kept as a parameter (rather than hard-coded) since tryFiberExtract() parses the whole segment's
  // original_content in one call; there's no multi-source numbering to offset anymore (see the
  // joined_group correction below).
  function parseOriginalContent(raw, k0) {
    const re = /<g\s+id="([^"]+)"\s*>([\s\S]*?)<\/g>|<x\s+id="([^"]+)"\s*\/>|<x\s+id="([^"]+)"\s*>([\s\S]*?)<\/x>/g;
    const marks = [];
    let k = k0;
    let out = '';
    let lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      out += decodeEntities(raw.slice(lastIndex, m.index));
      if (m[1] !== undefined) {
        marks.push({ t: 'g', s: norm(decodeEntities(m[2] || '')), gid: m[1] });
      } else if (m[3] !== undefined) {
        marks.push({ t: 'x', s: '', gid: m[3] });
      } else {
        marks.push({ t: 'x', s: norm(decodeEntities(m[5] || '')), gid: m[4] });
      }
      out += ' {{' + k + '}} ';
      k++;
      lastIndex = re.lastIndex;
    }
    out += decodeEntities(raw.slice(lastIndex));
    return { piece: norm(out), marks };
  }

  // CORRECTED 2026-10-xx: joined_group.children are SENTENCES (is_autojoined:true), not paragraphs —
  // confirmed live on segment 9579726127 (5 children = 5 sentences of ONE paragraph; treating them as
  // paragraphs produced PARA_MISMATCH_expN_got1 on 13/45 segments). Paragraph boundaries now come from
  // the DOM blocks again (the v3.0 source of truth that already worked for real H2+P segments) —
  // joined_group is not used at all. value.original_content is the single source of markers for the
  // WHOLE segment regardless of paragraph count; splitTemplateByDomBlocks() below aligns it against
  // the DOM blocks' own text to find paragraph boundaries within that one flat template.
  function tryFiberExtract(el, id, tn) {
    try {
      const value = findSegmentFiberValue(el, id);
      if (!value || typeof value.original_content !== 'string') return null;
      const parsed = parseOriginalContent(value.original_content, 0);
      const blocks = tn.querySelectorAll(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > p,:scope > li');
      if (blocks.length <= 1) {
        return { template: parsed.piece, marks: parsed.marks, paraCount: 1 };
      }
      const domBlockTexts = Array.prototype.map.call(blocks, (b) => norm(b.textContent));
      const pieces = splitTemplateByDomBlocks(parsed.piece, parsed.marks, domBlockTexts);
      if (!pieces) return null; // couldn't align fiber text to DOM blocks — caller falls back to tmpl()
      return { template: pieces.join(' [[P]] '), marks: parsed.marks, paraCount: blocks.length };
    } catch (e) {
      return null;
    }
  }

  // Splits one flat {{n}}-tokenized template into one piece per DOM block, by walking it as a
  // sequence of "atoms" (each atom is either a literal word, or a whole {{n}} token weighted by how
  // many NON-WHITESPACE CHARACTERS that marker's own label occupies — marks[n].s, 0 for an x-marker
  // that's invisible in the closed DOM too, so it correctly contributes nothing on both sides) and
  // greedily assigning atoms to each block until that block's own (closed-DOM) character count is
  // reached. Progress/comparison is char-based with ALL whitespace stripped, not word-based: fixed
  // 2026-10-xx after parseOriginalContent's own token padding (' {{n}} ') was found to split e.g.
  // "<g>x</g>." into atoms "{{0}}" and "." — a word-count/exact-whitespace comparison then saw an
  // extra "word"/space that the DOM side never had and failed every segment with trailing
  // punctuation right after a marker. Stripping whitespace before comparing makes that split
  // irrelevant (same total non-space characters either way). A reconstructed "expanded" text
  // (tokens substituted back to their label, whitespace stripped) must match the DOM block's text
  // (also whitespace-stripped) EXACTLY before a split is trusted — guards against a coincidental
  // count match that lands the boundary in the wrong place. Returns null (never guesses) if any
  // block can't be matched this way, or if atoms are left over/run short at the end.
  function splitTemplateByDomBlocks(template, marks, domBlockTexts) {
    const atomRe = /\{\{(\d+)\}\}|(\S+)/g;
    const atoms = [];
    let am;
    while ((am = atomRe.exec(template))) {
      if (am[1] !== undefined) {
        const n = parseInt(am[1], 10);
        const label = marks[n] && marks[n].s ? norm(marks[n].s) : '';
        atoms.push({ token: n, weight: label.replace(/\s/g, '').length });
      } else {
        atoms.push({ token: null, weight: am[2].length, word: am[2] });
      }
    }
    const pieces = [];
    let ai = 0;
    for (let bi = 0; bi < domBlockTexts.length; bi++) {
      const target = (domBlockTexts[bi] || '').replace(/\s/g, '');
      const pieceAtoms = [];
      let consumed = 0;
      while (ai < atoms.length && consumed < target.length) {
        pieceAtoms.push(atoms[ai]);
        consumed += atoms[ai].weight;
        ai++;
      }
      const expanded = pieceAtoms.map((a) => (a.token != null ? (marks[a.token].s || '') : a.word)).join(' ').replace(/\s/g, '');
      if (consumed !== target.length || expanded !== target) return null;
      pieces.push(pieceAtoms.map((a) => (a.token != null ? '{{' + a.token + '}}' : a.word)).join(' '));
    }
    if (ai !== atoms.length) return null; // leftover atoms never assigned to a block -> don't trust the split
    return pieces;
  }

  const findId = (id) =>
    document.querySelector('.AT-segment_list__segment_item[data-at-segment-id="' + id + '"]');

  async function seekFwd(id) {
    const sc = state.sc;
    let el = findId(id);
    if (el) return el;
    for (let g = 0; g < 70; g++) {
      if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 3) break;
      sc.scrollTop += 650;
      sc.dispatchEvent(new Event('scroll'));
      await sleep(SETTLE);
      el = findId(id);
      if (el) return el;
    }
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
    await sleep(700);
    for (let g2 = 0; g2 < 70; g2++) {
      el = findId(id);
      if (el) return el;
      if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 3) break;
      sc.scrollTop += 650;
      sc.dispatchEvent(new Event('scroll'));
      await sleep(SETTLE);
    }
    return null;
  }

  // WPML serves TipTap on some docs and classic TinyMCE on others — confirmed live 2026-09-16 on
  // the same account. v2.6 (ProseMirror-only) got NOEDITOR on every segment of a TinyMCE doc; the
  // original pre-2026-09-16 code (TinyMCE-only) had the mirror-image failure on TipTap docs.
  // Neither editor kind alone is enough — findLiveEditor() returns a normalized {kind, getHTML,
  // setHTML} handle for whichever one is actually open, or null. TipTap's instance is a DIRECT key
  // on the .ProseMirror DOM node (`node.editor`, NOT `.pm.editor`) and only exists while mounted.
  // Non-empty TEXT content (not just non-empty HTML — an empty "<p></p>" is non-empty as a string).
  function hasText(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return norm(d.textContent).length > 0;
  }

  // Live trace confirmed this race (TinyMCE, ms after click): editor ADD @123, our write @425, OK
  // returned @635, TinyMCE 'init' @834, ATE loads its own English content @838 and overwrites ours.
  // The editor object/DOM node can exist and report "not hidden" well before TinyMCE actually fires
  // init and before ATE has loaded its own content into it — requiring e.initialized (TinyMCE) and
  // non-empty text (both editors) closes the specific gap the trace showed, but see openEditor()'s
  // stability check below for the belt-and-suspenders part (ATE can still mutate content briefly
  // after this point).
  function findLiveEditor() {
    const nodes = document.querySelectorAll('.ProseMirror');
    for (let i = 0; i < nodes.length; i++) {
      const ed = nodes[i].editor;
      if (ed && ed.isEditable && hasText(ed.getHTML())) {
        return {
          kind: 'tiptap',
          getHTML: () => ed.getHTML(),
          setHTML: (html) => ed.chain().focus().setContent(html, true).run(),
        };
      }
    }
    if (gWindow.tinymce && gWindow.tinymce.get) {
      const list = gWindow.tinymce.get();
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const hidden = typeof e.isHidden === 'function' ? e.isHidden() : false;
        if (e && typeof e.getContent === 'function' && !hidden && e.initialized && hasText(e.getContent())) {
          return {
            kind: 'tinymce',
            getHTML: () => e.getContent(),
            setHTML: (html) => { e.setContent(html); e.fire('change'); if (e.save) e.save(); },
          };
        }
      }
    }
    return null;
  }

  async function closeEditor() {
    const b = document.querySelector('.AT-segment_list__close_translation_button');
    if (b) b.click();
    for (let i = 0; i < 40; i++) {
      await sleep(70);
      if (!findLiveEditor()) return true;
    }
    return false;
  }

  // Returns a ready editor handle, null if no editor ever appeared, or the string
  // 'EDITOR_NOT_READY' if one appeared but its content never stopped changing within the bound
  // below — doOne() must not write in that last case.
  async function openEditor(el) {
    const a = el.querySelector('.AT-segment_list__add_translation_button');
    if (a) a.click();
    else (el.querySelector('.AT-segment_list__open_translation') || el.querySelector('.AT-segment_list__translation') || el).click();
    let editor = null;
    for (let i = 0; i < 45; i++) {
      await sleep(80);
      editor = findLiveEditor();
      if (editor) break;
    }
    if (!editor) return null;
    // Content-stability check: ATE can keep mutating the editor's own initial content for a short
    // window even after findLiveEditor() first reports it ready+non-empty. Require two consecutive
    // reads ~150ms apart to match before trusting it enough to write into — bounded to 3 tries
    // (~450ms worst case) so a segment that's genuinely never stabilizing fails fast instead of
    // silently eating the full poll budget on every single segment.
    let prev = editor.getHTML();
    for (let i = 0; i < 3; i++) {
      await sleep(150);
      editor = findLiveEditor() || editor;
      const cur = editor.getHTML();
      if (cur === prev) return editor;
      prev = cur;
    }
    return 'EDITOR_NOT_READY';
  }

  // ---------- state ----------
  const state = {
    sc: null,
    it: [],
    q: [],
    run: { active: false, done: 0, total: 0, results: [], err: null },
    extractJob: null,
    vJob: null,
    errorLog: [],
  };

  // ---------- translate one segment ----------
  async function doOne(idx, tmplEs, linkTexts) {
    const meta = state.it[idx];
    if (!meta) return 'NOMETA';
    await closeEditor();
    const el = await seekFwd(meta.id);
    if (!el) return 'NOTFOUND';
    const ed = await openEditor(el);
    if (ed === 'EDITOR_NOT_READY') return 'EDITOR_NOT_READY';
    if (!ed) return 'NOEDITOR';
    await sleep(150); // was 350 (originally 180) — openEditor() already polls until the editor is live,
    // and setContent/setHTML applies instantly once it exists; this margin was dead wait, confirmed live 2026-09-16

    const d = document.createElement('div');
    d.innerHTML = ed.getHTML();
    const outer = outerMarks(d);
    const exp = meta.mk && meta.mk.length ? meta.mk.length : 0;
    if (outer.length !== exp) return 'MARKER_MISMATCH_exp' + exp + '_got' + outer.length;

    // Match by gid (editor chips carry data-segment="gid_N" — confirmed live 2026-10-08 on TinyMCE)
    // only when at least one chip in THIS open editor actually carries that attribute — unconfirmed
    // whether TipTap's chips do the same, so if none of them do, gid matching would silently fail
    // every marker (MARKER_MISMATCH) even though the chips are genuinely all there; fall back to
    // plain DOM order for the whole segment in that case, same as marks that never recorded a gid.
    const anyChipHasGid = outer.some((node) => node.hasAttribute('data-segment'));
    let html = tmplEs;
    for (let m = 0; m < exp; m++) {
      const gid = meta.mk[m] && meta.mk[m].gid;
      const chip = (gid != null && anyChipHasGid) ? outer.find((node) => node.getAttribute('data-segment') === gid) : outer[m];
      if (!chip) return 'MARKER_MISMATCH_exp' + exp + '_got' + outer.length;
      if (linkTexts && linkTexts[m] != null) {
        const inn = chip.querySelector('span');
        if (inn) inn.textContent = linkTexts[m];
        else chip.textContent = linkTexts[m];
      }
      html = html.split('{{' + m + '}}').join(chip.outerHTML);
    }
    if (/\{\{\d+\}\}/.test(html)) return 'PLACEHOLDER_LEFT';

    // was 700 (originally 170) — measured live 2026-09-16: WPML saves on the close-button click, not
    // a debounced open-time autosave; writes closed at 0/200/500ms all persisted after refresh.
    // 150 is TipTap safety margin (TinyMCE verified fine at 0ms, TipTap not separately 0-tested).
    // The "reverted to English" incident was the NOEDITOR bug, now fixed — not a save race after all.
    const SAVE_WAIT = 150;

    const paraCount = meta.paraCount || 1;
    if (paraCount <= 1) {
      ed.setHTML('<p>' + html + '</p>');
      await sleep(SAVE_WAIT);

      // Read back what the editor actually has NOW and confirm it matches what we JUST tried to
      // write — not "differs from the old English source", since a segment that's purely a
      // never-translated marker (bare phone/shortcode link, linkTexts[m]==null) legitimately has
      // identical text to the source, and comparing against the source would flag that correct case
      // as a false failure. Catches a save that silently no-ops (wrong API, WPML swallowing it) so
      // it shows up as a real error in prog().bad instead of a false OK.
      const intendedDiv = document.createElement('div');
      intendedDiv.innerHTML = '<p>' + html + '</p>';
      let afterDiv = document.createElement('div');
      afterDiv.innerHTML = ed.getHTML();
      if (norm(afterDiv.textContent) !== norm(intendedDiv.textContent)) return 'CONTENT_NOT_APPLIED';

      // Guard against a DELAYED external overwrite (confirmed live: our write + the check above both
      // looked fine, then ATE's own init-time content load fired ~400ms later and silently clobbered
      // it). Rewrite once if reverted, but always report CONTENT_REVERTED rather than re-checking and
      // returning OK — this needs to stay visible/countable, not silently self-heal.
      await sleep(300);
      afterDiv = document.createElement('div');
      afterDiv.innerHTML = ed.getHTML();
      if (norm(afterDiv.textContent) !== norm(intendedDiv.textContent)) {
        ed.setHTML('<p>' + html + '</p>');
        await sleep(SAVE_WAIT);
        return 'CONTENT_REVERTED';
      }
      return 'OK';
    }

    // Grouped segment (heading + paragraph(s) merged into one segment by WPML). tmplEs carries
    // " [[P]] " between blocks (see tmpl()) — split back into one piece per block and write one <p>
    // per piece, so TipTap keeps the same paragraph COUNT it had before (ATE tracks heading-ness by
    // paragraph position, not tag — ed.getHTML() only ever has plain <p>s either way).
    const pieces = html.split('[[P]]').map((p) => p.trim());
    const gotParas = d.querySelectorAll(':scope > p').length;
    if (gotParas !== pieces.length) return 'PARA_MISMATCH_exp' + pieces.length + '_got' + gotParas;

    const writeHtml = pieces.map((p) => '<p>' + p + '</p>').join('');
    ed.setHTML(writeHtml);
    await sleep(SAVE_WAIT);

    // Per-paragraph readback, not whole-textContent — a translation that swaps two paragraphs'
    // content (same total text, wrong position) must not pass as OK.
    const intendedDiv = document.createElement('div');
    intendedDiv.innerHTML = writeHtml;
    const intendedPs = intendedDiv.querySelectorAll(':scope > p');
    function paragraphsMatch() {
      const afterDiv = document.createElement('div');
      afterDiv.innerHTML = ed.getHTML();
      const afterPs = afterDiv.querySelectorAll(':scope > p');
      if (afterPs.length !== intendedPs.length) return false;
      for (let p = 0; p < intendedPs.length; p++) {
        if (norm(afterPs[p].textContent) !== norm(intendedPs[p].textContent)) return false;
      }
      return true;
    }
    if (!paragraphsMatch()) return 'CONTENT_NOT_APPLIED';

    // Same delayed-overwrite guard as the single-paragraph path above — see that comment.
    await sleep(300);
    if (!paragraphsMatch()) {
      ed.setHTML(writeHtml);
      await sleep(SAVE_WAIT);
      return 'CONTENT_REVERTED';
    }
    return 'OK';
  }

  async function drain() {
    if (state.run.active) return;
    state.run.active = true;
    try {
      while (state.q.length) {
        const t = state.q.shift();
        state.run.results.push(t[0] + ':' + (await doOne(t[0], t[1], t[2])));
        state.run.done++;
      }
      await closeEditor();
    } catch (e) {
      state.run.err = String(e && e.message);
    }
    state.run.active = false;
  }

  // ---------- extraction ----------
  function startExtract() {
    state.extractJob = { done: false, items: [], total: 0 };
    (async function () {
      const sc = scroller();
      state.sc = sc;
      if (!sc) { state.extractJob.done = true; state.extractJob.err = 'no scroller'; return; }
      const seen = {}; // id -> index into state.extractJob.items, so a segment can be re-captured in place
      const fiberFallbackWarned = {}; // id -> true, so a re-captured-every-pass segment only logs once
      function cap() {
        const items = document.querySelectorAll('.AT-segment_list__segment_item');
        for (let i = 0; i < items.length; i++) {
          const id = items[i].getAttribute('data-at-segment-id');
          if (!id) continue;
          const tn = textNode(items[i]);
          if (!tn) continue;
          // Fiber-based extraction first (sees hidden "x" marker chips even while closed — see
          // tryFiberExtract() above); DOM-based tmpl() only as a fallback, logged when it's used so a
          // page where fiber lookup never works isn't silently missing markers again.
          let t = tryFiberExtract(items[i], id, tn);
          if (!t) {
            if (!fiberFallbackWarned[id]) {
              fiberFallbackWarned[id] = true;
              logRetryWarn('extract fiber lookup failed, using DOM fallback', 'segment ' + id);
            }
            t = tmpl(tn);
          }
          const add = items[i].querySelector('.AT-segment_list__add_translation_button');
          // Same check startVerify() uses to flag "english" after the fact — applied here too so a
          // segment stuck in English (e.g. from the CONTENT_REVERTED race) gets need:true and isn't
          // skipped as "already translated" on the next Translate Page run.
          const tr = items[i].querySelector('.AT-segment_list__translation');
          const key = norm(tn.textContent);
          const stuckEnglish = !add && tr && norm(tr.textContent) === key;
          const entry = {
            id,
            k: key,
            tp: t.template,
            mk: t.marks,
            paraCount: t.paraCount,
            need: !!add || stuckEnglish,
          };
          if (seen[id] == null) {
            seen[id] = state.extractJob.items.length;
            state.extractJob.items.push(entry);
            state.extractJob.total++;
          } else {
            // Re-captured while still visible. Confirmed live (segment 9560024139): an "x"
            // marker-code chip ("< 2 >") was missing from the very first capture and present on a
            // later one — WPML can render a segment's chips a tick after it first scrolls into view.
            // Overwrite with the latest capture every time cap() still sees this segment, so whichever
            // pass finally shows the complete chip set is the one extract() keeps.
            state.extractJob.items[seen[id]] = entry;
          }
        }
      }
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll'));
      await sleep(700);
      cap();
      for (let s = 0; s < 80; s++) {
        if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 3) break;
        sc.scrollTop += 650;
        sc.dispatchEvent(new Event('scroll'));
        await sleep(SETTLE);
        cap();
      }
      await sleep(600);
      cap();
      state.it = state.extractJob.items;
      state.extractJob.done = true;
    })();
    return 'extract started';
  }

  // ---------- verify ----------
  function startVerify() {
    state.vJob = { done: false, total: 0, missing: [], english: [], markerLost: [] };
    (async function () {
      const sc = state.sc || scroller();
      state.sc = sc;
      const seen = {};
      function cap() {
        const items = document.querySelectorAll('.AT-segment_list__segment_item');
        for (let i = 0; i < items.length; i++) {
          const id = items[i].getAttribute('data-at-segment-id');
          if (!id || seen[id]) continue;
          const tn = textNode(items[i]);
          if (!tn) continue;
          seen[id] = true;
          state.vJob.total++;
          const key = norm(tn.textContent);
          const add = items[i].querySelector('.AT-segment_list__add_translation_button');
          const tr = items[i].querySelector('.AT-segment_list__translation');
          if (add) { state.vJob.missing.push(id + ':' + key.slice(0, 40)); continue; }
          if (tr && norm(tr.textContent) === key) state.vJob.english.push(id + ':' + key.slice(0, 40));
          const om = tn.querySelectorAll('span[class*="ate-chip--marker"]').length;
          if (om > 0 && tr) {
            const tm = tr.querySelectorAll('span[class*="ate-chip--marker"]').length;
            if (tm < om) state.vJob.markerLost.push(key.slice(0, 40) + ' [' + om + '->' + tm + ']');
          }
        }
      }
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll'));
      await sleep(700);
      cap();
      for (let s = 0; s < 80; s++) {
        if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 3) break;
        sc.scrollTop += 600;
        sc.dispatchEvent(new Event('scroll'));
        await sleep(470);
        cap();
      }
      await sleep(600);
      cap();
      state.vJob.done = true;
    })();
    return 'verify started';
  }

  // ---------- AI translation (Gemini / Claude / OpenAI) ----------
  const GEMINI_KEY_STORE = 'wpml_gemini_api_key';
  const CLAUDE_KEY_STORE = 'wpml_claude_api_key';
  const OPENAI_KEY_STORE = 'wpml_openai_api_key';
  const KEY_STORES = { gemini: GEMINI_KEY_STORE, claude: CLAUDE_KEY_STORE, openai: OPENAI_KEY_STORE };
  // gemini-3.6-flash / claude-sonnet-5: confirmed working on live traffic (the Gemini one from the
  // API's own 404 error naming its replacement). gpt-5.1 is NOT confirmed the same way — it's a
  // best guess for "current OpenAI flagship as of this file's last edit," postdates this assistant's
  // training data, and hasn't been exercised against a real OpenAI call. If it 404s, the error
  // should name the real current model — same recovery path as the original Gemini mixup — then
  // update via wpml.ai.config({model:'...'}) or the panel's model isn't user-facing yet, so console.
  const AI_MODEL_DEFAULTS = { gemini: 'gemini-3.6-flash', claude: 'claude-sonnet-5', openai: 'gpt-5.1' };
  // concurrency: how many batches' AI calls approve() runs in flight at once. Default 1 = exactly
  // the old sequential behavior (no change until explicitly raised via wpml.ai.config({concurrency:N})).
  const AI_DEFAULTS = { provider: 'gemini', model: AI_MODEL_DEFAULTS.gemini, targetLang: null, sourceLang: 'English', batchSize: 25, exclude: [], concurrency: 1 };
  const MAX_MARKER_RETRIES = 2;
  const MAX_NETWORK_RETRIES = 3;

  state.ai = {
    config: Object.assign({}, AI_DEFAULTS),
    batches: [],
    batchIndex: 0,
    results: {},
    failed: {},
    awaitingApproval: false,
    running: false,
    lastError: null,
    lastPreviewRows: [],
    jobs: {}, // batch index -> in-flight/settled translateBatchWithRetry() promise, see primeJobs()
    nextLaunch: 0, // next batch index primeJobs() hasn't launched yet
  };

  function aiBuildSegments() {
    const ex = new Set(state.ai.config.exclude || []);
    const out = [];
    for (let i = 0; i < state.it.length; i++) {
      if (!state.it[i].need || ex.has(i)) continue;
      out.push({ i, tp: state.it[i].tp, mk: state.it[i].mk, paraCount: state.it[i].paraCount });
    }
    return out;
  }

  function aiChunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function aiSchema() {
    return {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              i: { type: 'integer' },
              tmpl: { type: 'string' },
              linkTexts: { type: 'array', items: { type: 'string', nullable: true } },
            },
            required: ['i', 'tmpl', 'linkTexts'],
          },
        },
      },
      required: ['segments'],
    };
  }

  function aiPrompt(batch, cfg, corrections) {
    const lines = [];
    lines.push('You are translating WPML CMS text segments from ' + cfg.sourceLang + ' to ' + cfg.targetLang + '.');
    lines.push('Each segment has "tp": text containing zero or more tokens like {{0}}, {{1}}, ... standing in for markers (links, shortcodes, phone numbers, etc). These tokens are structural placeholders, not translatable text.');
    lines.push('Rules, no exceptions:');
    lines.push('1. Every {{n}} token in "tp" must appear EXACTLY ONCE in your translated "tmpl", with the identical number n. Never rename, drop, duplicate, or add a token.');
    lines.push('2. You may reposition a token within the sentence to fit target-language grammar, but never alter the digits inside {{ }}.');
    lines.push('3. Translate all other text naturally into ' + cfg.targetLang + '.');
    lines.push('4. Each segment lists "mk": one entry per {{n}} token, in order, as {t, s} (t=marker type, s=marker\'s own text). For each marker: if t is "x", or "s" looks like a URL, phone number, email, or shortcode/code, output null at that position in "linkTexts". If t is "g" and "s" is human-readable text (e.g. a link label), output a natural ' + cfg.targetLang + ' translation of "s" at that position in "linkTexts" instead. "linkTexts" must have exactly one entry per marker, in marker order.');
    lines.push('5. [[P]] is a paragraph break. Keep every [[P]] exactly once, in the same order. Never merge or split paragraphs.');
    lines.push('Return ONLY the JSON per the response schema: {"segments": [...]}, one entry per input segment (matching "i"), no commentary.');
    lines.push('');
    if (corrections && Object.keys(corrections).length) {
      lines.push('These segments failed validation last attempt — fix ONLY the stated problem, keep everything else the same:');
      for (const i in corrections) lines.push('- i=' + i + ': ' + corrections[i]);
      lines.push('');
    }
    lines.push('Input segments:');
    lines.push(JSON.stringify(batch));
    return lines.join('\n');
  }

  // Gemini (and possibly Claude) sometimes renders quotation marks as literal << >> instead of " ".
  // Only the exact double-angle-bracket pattern is touched — real HTML markup doesn't exist in
  // "tmpl" yet at this point (marker outerHTML is spliced in later, inside doOne), so this can't
  // collide with a tag. Applied to both providers' output.
  function normalizeAiQuotes(s) {
    return typeof s === 'string' ? s.replace(/<<([^<>]*)>>/g, '"$1"') : s;
  }

  // Ring buffer feeding the panel's Error Log section — same console.warn call as before, just
  // also captured so it survives after the console has scrolled past it.
  const MAX_ERROR_LOG = 20;
  function logRetryWarn(label, detail) {
    console.warn('[wpml.ai] ' + label + ':', detail);
    state.errorLog.push({ t: Date.now(), label, detail: String(detail).slice(0, 500) });
    if (state.errorLog.length > MAX_ERROR_LOG) state.errorLog.shift();
  }

  // 429 is almost always a per-minute quota window on the free tiers of both providers, not a
  // transient blip — a short exponential backoff (previously 1s/2s/4s, ~7s total) gives up long
  // before that window rolls over. 5xx is genuinely transient, so it keeps the quick backoff.
  function retryDelayMs(status, attempt) {
    return status === 429 ? 15000 * Math.pow(2, attempt) : 1000 * Math.pow(2, attempt);
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(Object.assign({
        onload: resolve,
        onerror: (e) => reject(new Error('network error: ' + JSON.stringify(e))),
        ontimeout: () => reject(new Error('request timed out')),
      }, opts));
    });
  }

  async function geminiCall(promptText, cfg) {
    const key = GM_getValue(GEMINI_KEY_STORE, null);
    if (!key) throw new Error('No Gemini API key set. Run wpml.ai.setKey("...") first.');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + cfg.model + ':generateContent?key=' + encodeURIComponent(key);
    const generationConfig = { responseMimeType: 'application/json', responseSchema: aiSchema(), temperature: 0.2 };
    // thinkingConfig.thinkingLevel is a Gemini-3-only field (confirmed against ai.google.dev/gemini-api/docs/thinking
    // 2026-10-06) — the 2.5 line used a different field (thinkingBudget) entirely, so this is gated on
    // the model string rather than applied unconditionally. 'low' over 'minimal': this task needs
    // reliable structured JSON with exact {{n}}/marker preservation, and minimal is the setting most
    // likely to cost accuracy on that.
    if (cfg.model && cfg.model.indexOf('gemini-3') === 0) {
      generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    }
    const bodyObj = {
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      generationConfig,
    };
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
      let res;
      try {
        res = await gmRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(bodyObj), timeout: 60000 });
      } catch (e) {
        lastErr = e;
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('Gemini HTTP ' + res.status);
        // Body distinguishes a per-minute RPM window (clears with backoff) from a daily/quota
        // exhaustion (backoff alone won't fix it) — surfaced here since the thrown Error only says "429".
        logRetryWarn('Gemini HTTP ' + res.status + ' (attempt ' + (attempt + 1) + '/' + MAX_NETWORK_RETRIES + ')', res.responseText);
        await sleep(retryDelayMs(res.status, attempt));
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('Gemini HTTP ' + res.status + ': ' + String(res.responseText).slice(0, 300));
      }
      let data;
      try { data = JSON.parse(res.responseText); } catch (e) { throw new Error('Gemini response was not JSON'); }
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (!text) throw new Error('Gemini response missing text content');
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error('Gemini output was not valid JSON'); }
      if (!parsed || !Array.isArray(parsed.segments)) throw new Error('Gemini output missing "segments" array');
      parsed.segments.forEach((seg) => {
        if (!seg || typeof seg !== 'object') return;
        seg.tmpl = normalizeAiQuotes(seg.tmpl);
        if (Array.isArray(seg.linkTexts)) seg.linkTexts = seg.linkTexts.map(normalizeAiQuotes);
      });
      return parsed.segments;
    }
    throw lastErr || new Error('Gemini call failed after retries');
  }

  // Claude structured output uses a forced tool call rather than Gemini's responseSchema —
  // tool_choice pins the model to always call this one tool, so its "input" is always our shape.
  function claudeTool() {
    return {
      name: 'submit_translations',
      description: 'Return the translated WPML segments.',
      input_schema: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                i: { type: 'integer' },
                tmpl: { type: 'string' },
                linkTexts: { type: 'array', items: { type: ['string', 'null'] } },
              },
              required: ['i', 'tmpl', 'linkTexts'],
            },
          },
        },
        required: ['segments'],
      },
    };
  }

  async function claudeCall(promptText, cfg) {
    const key = GM_getValue(CLAUDE_KEY_STORE, null);
    if (!key) throw new Error('No Claude API key set. Run wpml.ai.config({provider:"claude"}) then wpml.ai.setKey("sk-ant-...") first.');
    const url = 'https://api.anthropic.com/v1/messages';
    const tool = claudeTool();
    const bodyObj = {
      model: cfg.model,
      max_tokens: 8192,
      temperature: 0.2,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: promptText }],
    };
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
      let res;
      try {
        res = await gmRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          data: JSON.stringify(bodyObj), timeout: 60000,
        });
      } catch (e) {
        lastErr = e;
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('Claude HTTP ' + res.status);
        logRetryWarn('Claude HTTP ' + res.status + ' (attempt ' + (attempt + 1) + '/' + MAX_NETWORK_RETRIES + ')', res.responseText);
        await sleep(retryDelayMs(res.status, attempt));
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('Claude HTTP ' + res.status + ': ' + String(res.responseText).slice(0, 300));
      }
      let data;
      try { data = JSON.parse(res.responseText); } catch (e) { throw new Error('Claude response was not JSON'); }
      const block = data && Array.isArray(data.content) ? data.content.find((b) => b && b.type === 'tool_use') : null;
      if (!block || !block.input) throw new Error('Claude response missing tool_use block');
      const parsed = block.input;
      if (!parsed || !Array.isArray(parsed.segments)) throw new Error('Claude output missing "segments" array');
      parsed.segments.forEach((seg) => {
        if (!seg || typeof seg !== 'object') return;
        seg.tmpl = normalizeAiQuotes(seg.tmpl);
        if (Array.isArray(seg.linkTexts)) seg.linkTexts = seg.linkTexts.map(normalizeAiQuotes);
      });
      return parsed.segments;
    }
    throw lastErr || new Error('Claude call failed after retries');
  }

  // OpenAI's reliable-JSON mechanism is response_format:{type:'json_schema',strict:true} on Chat
  // Completions — the schema itself is the same shape aiSchema()/claudeTool() already describe.
  function openaiSchema() {
    return {
      name: 'submit_translations',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                i: { type: 'integer' },
                tmpl: { type: 'string' },
                linkTexts: { type: 'array', items: { type: ['string', 'null'] } },
              },
              required: ['i', 'tmpl', 'linkTexts'],
              additionalProperties: false,
            },
          },
        },
        required: ['segments'],
        additionalProperties: false,
      },
    };
  }

  async function openaiCall(promptText, cfg) {
    const key = GM_getValue(OPENAI_KEY_STORE, null);
    if (!key) throw new Error('No OpenAI API key set. Run wpml.ai.config({provider:"openai"}) then wpml.ai.setKey("sk-...") first.');
    const url = 'https://api.openai.com/v1/chat/completions';
    const bodyObj = {
      model: cfg.model,
      temperature: 0.2,
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_schema', json_schema: openaiSchema() },
    };
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
      let res;
      try {
        res = await gmRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          data: JSON.stringify(bodyObj), timeout: 60000,
        });
      } catch (e) {
        lastErr = e;
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('OpenAI HTTP ' + res.status);
        logRetryWarn('OpenAI HTTP ' + res.status + ' (attempt ' + (attempt + 1) + '/' + MAX_NETWORK_RETRIES + ')', res.responseText);
        await sleep(retryDelayMs(res.status, attempt));
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('OpenAI HTTP ' + res.status + ': ' + String(res.responseText).slice(0, 300));
      }
      let data;
      try { data = JSON.parse(res.responseText); } catch (e) { throw new Error('OpenAI response was not JSON'); }
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('OpenAI response missing message content');
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error('OpenAI output was not valid JSON'); }
      if (!parsed || !Array.isArray(parsed.segments)) throw new Error('OpenAI output missing "segments" array');
      parsed.segments.forEach((seg) => {
        if (!seg || typeof seg !== 'object') return;
        seg.tmpl = normalizeAiQuotes(seg.tmpl);
        if (Array.isArray(seg.linkTexts)) seg.linkTexts = seg.linkTexts.map(normalizeAiQuotes);
      });
      return parsed.segments;
    }
    throw lastErr || new Error('OpenAI call failed after retries');
  }

  function callProvider(promptText, cfg) {
    if (cfg.provider === 'claude') return claudeCall(promptText, cfg);
    if (cfg.provider === 'openai') return openaiCall(promptText, cfg);
    return geminiCall(promptText, cfg);
  }

  function validateAiSegment(out, byIdx) {
    if (!out || typeof out.i !== 'number' || !byIdx[out.i]) return 'UNKNOWN_INDEX';
    if (typeof out.tmpl !== 'string') return 'TMPL_NOT_STRING';
    const expected = byIdx[out.i].mk ? byIdx[out.i].mk.length : 0;
    const seen = {};
    const re = /\{\{(\d+)\}\}/g;
    let m; let total = 0;
    while ((m = re.exec(out.tmpl))) {
      total++;
      const n = parseInt(m[1], 10);
      if (n >= expected) return 'TOKEN_OUT_OF_RANGE_' + n;
      seen[n] = (seen[n] || 0) + 1;
    }
    for (let n = 0; n < expected; n++) {
      if (!seen[n]) return 'MISSING_TOKEN_' + n;
      if (seen[n] > 1) return 'DUPLICATE_TOKEN_' + n;
    }
    if (total !== expected) return 'TOKEN_COUNT_MISMATCH';
    const expectedParas = (byIdx[out.i].paraCount || 1) - 1;
    const gotParas = (out.tmpl.match(/\[\[P\]\]/g) || []).length;
    if (gotParas !== expectedParas) return 'PARA_COUNT_MISMATCH_exp' + expectedParas + '_got' + gotParas;
    const lt = out.linkTexts || [];
    if (lt.length !== expected) return 'LINKTEXTS_LENGTH_MISMATCH_exp' + expected + '_got' + lt.length;
    return null;
  }

  async function translateBatchWithRetry(batch) {
    const cfg = state.ai.config;
    const byIdx = {};
    batch.forEach((s) => { byIdx[s.i] = s; });
    let pending = batch;
    let lastCorrections = null;
    const outputs = {};
    for (let attempt = 0; attempt <= MAX_MARKER_RETRIES; attempt++) {
      const segsOut = await callProvider(aiPrompt(pending, cfg, lastCorrections), cfg);
      const stillBad = [];
      const corrections = {};
      const returned = {};
      segsOut.forEach((out) => {
        const oi = out && typeof out === 'object' ? out.i : undefined;
        returned[oi] = true;
        const err = validateAiSegment(out, byIdx);
        if (err) { corrections[oi] = err; if (byIdx[oi]) stillBad.push(byIdx[oi]); }
        else outputs[oi] = out;
      });
      pending.forEach((s) => {
        if (!returned[s.i]) { corrections[s.i] = 'NO_OUTPUT_RETURNED'; stillBad.push(s); }
      });
      lastCorrections = corrections;
      if (!stillBad.length) break;
      pending = stillBad;
      if (attempt === MAX_MARKER_RETRIES) {
        pending.forEach((s) => { state.ai.failed[s.i] = corrections[s.i]; });
      }
    }
    return outputs;
  }

  // Shared batch-job pipeline, used by both translate() and approve() so a batch's AI call can
  // start in the background during the human review pause after batch 0, instead of sitting idle
  // until approve() is clicked (measured live: batch 2 took 54s, writer idle 23s waiting for it
  // AFTER approval — that 23s is exactly the dead time this removes). approve() still does all the
  // actual QUEUEing (api.queue()/DOM writes) — this only ever runs the AI call ahead of time.
  // state.ai.nextLaunch/jobs are reset fresh in translate(); approve() just keeps draining+topping
  // up the same pipeline, so a job already in flight (or already finished) when approve() reaches it
  // is reused as-is, never re-translated.
  function launchBatch(b) {
    // .catch() here, not left to the caller — an in-flight background job whose batch is never
    // reached (e.g. review abandoned, or a later resume restarts) must never become an unhandled
    // rejection (the v1.4 "Uncaught (in promise)" failure mode).
    state.ai.jobs[b] = translateBatchWithRetry(state.ai.batches[b])
      .then((outputs) => ({ outputs }))
      .catch((error) => ({ error }));
  }
  function primeJobs() {
    const cap = Math.max(1, state.ai.config.concurrency || 1);
    const total = state.ai.batches.length;
    while (state.ai.nextLaunch < total && Object.keys(state.ai.jobs).length < cap) {
      launchBatch(state.ai.nextLaunch);
      state.ai.nextLaunch++;
    }
  }

  function queueOutputs(outputs, batch) {
    const pairs = [];
    batch.forEach((s) => { const o = outputs[s.i]; if (o) pairs.push([o.i, o.tmpl, o.linkTexts]); });
    if (pairs.length) api.queue(pairs);
    return pairs.length;
  }

  function aiPreview(outputs, batch) {
    console.log('%c[wpml.ai] batch 1 of ' + state.ai.batches.length + ' translated — review, then run wpml.ai.approve()', 'color:#2196F3;font-weight:bold');
    const rows = batch.map((s) => {
      const o = outputs[s.i];
      return {
        i: s.i,
        source: s.tp,
        translated: o ? o.tmpl : '(FAILED: ' + state.ai.failed[s.i] + ')',
        linkTexts: o ? JSON.stringify(o.linkTexts) : '',
      };
    });
    state.ai.lastPreviewRows = rows; // same data console.table just printed — lets the panel render it without opening devtools
    if (console.table) console.table(rows); else rows.forEach((r) => console.log(r));
  }

  // ---------- public API ----------
  const api = {
    // extract all segments
    extract() { return startExtract(); },
    // status of extraction
    eprog() {
      const j = state.extractJob;
      if (!j) return 'no extract yet';
      return { done: j.done, total: j.total, withMarks: j.items.filter((x) => x.mk.length).length };
    },
    // read all segments as an array of {i, mk, tp} — copy this out to translate
    read() {
      return state.it.map((s, i) => ({ i, mk: s.mk.length ? s.mk : undefined, tp: s.tp }));
    },
    // enqueue translations
    queue(pairs) {
      for (let i = 0; i < pairs.length; i++) state.q.push(pairs[i]);
      state.run.total += pairs.length;
      drain();
      return 'queued ' + pairs.length + ' (total ' + state.run.total + ')';
    },
    // translation progress
    prog() {
      const bad = state.run.results.filter((r) => r.indexOf(':OK') === -1);
      return {
        done: state.run.done,
        total: state.run.total,
        active: state.run.active,
        queue: state.q.length,
        err: state.run.err,
        bad,
      };
    },
    // patch mk length after MARKER_MISMATCH_expN_gotM, then re-queue
    fixMk(idx, n) {
      const arr = [];
      for (let i = 0; i < n; i++) arr.push({ t: 'x', s: 'marker' });
      state.it[idx].mk = arr;
      return state.it[idx];
    },
    // start post-run verification
    verify() { closeEditor().then(startVerify); return 'verify started'; },
    vprog() {
      const v = state.vJob;
      if (!v) return 'no verify yet';
      return { done: v.done, total: v.total, missing: v.missing, english: v.english, markerLost: v.markerLost };
    },
    // low-level access for debugging
    _state: state,
  };

  // ---------- AI translation public API ----------
  function currentKeyStore() {
    return KEY_STORES[state.ai.config.provider] || GEMINI_KEY_STORE;
  }

  api.ai = {
    // store the API key for the CURRENTLY configured provider (see config({provider})) via
    // Tampermonkey's isolated storage — never put a key in this file. Gemini/Claude keys are
    // stored separately, so switching provider never loses the other one's key.
    setKey(key) { GM_setValue(currentKeyStore(), key); return 'key stored for ' + state.ai.config.provider; },
    hasKey() { return !!GM_getValue(currentKeyStore(), null); },
    // e.g. wpml.ai.config({targetLang:'es', exclude:[137]}) or wpml.ai.config({provider:'claude'})
    // switching provider without an explicit model auto-fills that provider's default model.
    config(opts) {
      opts = opts || {};
      if (opts.provider && opts.provider !== state.ai.config.provider && !opts.model) {
        opts = Object.assign({}, opts, { model: AI_MODEL_DEFAULTS[opts.provider] || state.ai.config.model });
      }
      Object.assign(state.ai.config, opts);
      return state.ai.config;
    },
    // translate + validate batch 1 only, print a preview, then wait for approve()
    async translate() {
      if (state.ai.running) return 'already running';
      if (!state.ai.config.targetLang) throw new Error('Set target language first: wpml.ai.config({targetLang:"es"})');
      if (!GM_getValue(currentKeyStore(), null)) throw new Error('No API key for provider "' + state.ai.config.provider + '". Run wpml.ai.setKey("...") first.');
      state.ai.running = true;
      try {
        const segs = aiBuildSegments();
        state.ai.batches = aiChunk(segs, state.ai.config.batchSize);
        state.ai.batchIndex = 0;
        state.ai.results = {};
        state.ai.failed = {};
        state.ai.jobs = {};
        state.ai.nextLaunch = 0;
        state.ai.awaitingApproval = false;
        if (!state.ai.batches.length) return 'nothing to translate';
        const first = state.ai.batches[0];
        let outputs;
        try {
          outputs = await translateBatchWithRetry(first);
        } catch (e) {
          state.ai.lastError = 'batch 0 failed: ' + e.message + ' — fix the issue (e.g. rate limit/quota) then run wpml.ai.translate() again';
          return state.ai.lastError;
        }
        state.ai.lastError = null;
        Object.assign(state.ai.results, outputs);
        state.ai.awaitingApproval = true;
        aiPreview(outputs, first);
        // Batch 0 was just translated directly above (not through the job pipeline) — start the
        // pipeline from batch 1 so the remaining batches begin translating now, in the background,
        // while the human reviews. approve() will pick up whatever's already finished/in-flight.
        state.ai.nextLaunch = 1;
        primeJobs();
        return 'batch 1 of ' + state.ai.batches.length + ' translated — review above, then wpml.ai.approve()';
      } finally {
        state.ai.running = false;
      }
    },
    // queues batch 1 (nothing is queued before this call), then translates+queues the rest.
    // Resumable: if a prior call stopped early on a batch failure (see lastError), calling this
    // again picks up at that same batch instead of requiring a fresh translate() + re-approve.
    async approve() {
      const resuming = !state.ai.awaitingApproval && state.ai.lastError && state.ai.batchIndex < state.ai.batches.length;
      if (!state.ai.awaitingApproval && !resuming) return 'nothing awaiting approval';
      if (state.ai.running) return 'already running';
      state.ai.running = true;
      let startBatch = state.ai.batchIndex;
      if (state.ai.awaitingApproval) {
        state.ai.awaitingApproval = false;
        queueOutputs(state.ai.results, state.ai.batches[0]);
        startBatch = 1;
      }
      state.ai.lastError = null;
      try {
        const total = state.ai.batches.length;
        // Batches are always QUEUED in order (nextQueue) regardless of which finishes translating
        // first, so segments still land in document order. The jobs themselves (state.ai.jobs,
        // via primeJobs()) are shared with translate() — a job already running (started during the
        // review pause) or already settled here is reused as-is, never re-translated. cap=1 (the
        // default) with nothing pre-launched degenerates to exactly the old sequential loop.
        let nextQueue = startBatch;
        primeJobs(); // no-op if translate() already filled the pipeline; tops it up on a fresh resume

        while (nextQueue < total) {
          const result = await state.ai.jobs[nextQueue];
          delete state.ai.jobs[nextQueue];
          if (result.error) {
            state.ai.batchIndex = nextQueue;
            state.ai.lastError = 'batch ' + nextQueue + ' of ' + total + ' failed: ' + result.error.message +
              ' — fix the issue (e.g. rate limit/quota) then run wpml.ai.approve() again to resume from this batch';
            // Batches beyond this point that were already in flight and happened to succeed are
            // discarded here (not awaited/queued) — simplest safe semantics; resume re-translates
            // them (nextLaunch rewound below) rather than risk queuing out of order around a failure.
            state.ai.jobs = {};
            state.ai.nextLaunch = nextQueue;
            return state.ai.lastError;
          }
          Object.assign(state.ai.results, result.outputs);
          queueOutputs(result.outputs, state.ai.batches[nextQueue]);
          state.ai.batchIndex = nextQueue + 1;
          nextQueue++;
          primeJobs(); // keep the pipeline topped up to cap as each batch is consumed
        }
        return 'queued all batches. Failed segments: ' + Object.keys(state.ai.failed).length + ' (see wpml.ai.status())';
      } finally {
        state.ai.running = false;
      }
    },
    // re-attempt segments that exhausted retries during translate()/approve()
    async retryFailed() {
      const idxs = Object.keys(state.ai.failed).map(Number);
      if (!idxs.length) return 'no failed segments';
      if (state.ai.running) return 'already running';
      state.ai.running = true;
      try {
        const segs = aiBuildSegments().filter((s) => idxs.indexOf(s.i) !== -1);
        let outputs;
        try {
          outputs = await translateBatchWithRetry(segs);
        } catch (e) {
          state.ai.lastError = 'retryFailed failed: ' + e.message + ' — fix the issue then run wpml.ai.retryFailed() again';
          return state.ai.lastError;
        }
        state.ai.lastError = null;
        Object.assign(state.ai.results, outputs);
        Object.keys(outputs).forEach((k) => { delete state.ai.failed[k]; });
        queueOutputs(outputs, segs);
        return 'retried ' + segs.length + ', still failing: ' + Object.keys(state.ai.failed).length;
      } finally {
        state.ai.running = false;
      }
    },
    status() {
      return {
        provider: state.ai.config.provider,
        model: state.ai.config.model,
        awaitingApproval: state.ai.awaitingApproval,
        running: state.ai.running,
        batchesDone: state.ai.batchIndex,
        batchesTotal: state.ai.batches.length,
        translated: Object.keys(state.ai.results).length,
        failed: state.ai.failed,
        lastError: state.ai.lastError,
      };
    },
    // last MAX_ERROR_LOG retry warnings (429/5xx bodies) captured by geminiCall/claudeCall — feeds the panel's Error Log section
    errorLog() { return state.errorLog.slice(); },
    // the same source/translated/linkTexts rows the last translate() call logged via console.table — feeds the panel's preview section
    previewRows() { return state.ai.lastPreviewRows.slice(); },
  };

  gWindow.wpml = api;

  console.log('%c[WPML Batch Translator]', 'color:#4CAF50;font-weight:bold', 'loaded. Use wpml.extract() to start. Full API on window.wpml');

  // ---------- floating panel (UI only — every button calls an existing api.*/api.ai.* method) ----------
  const PANEL_STATE_STORE = 'wpml_panel_state';
  // panel-only memory of the last-used target language — never auto-applied, only pre-fills the
  // input. "exclude" is deliberately NOT stored here: it's a list of positions into whatever the
  // last extract() call captured (see the index-is-positional-not-segment-id design note above),
  // so a value that was correct for one page/job can silently point at a real, different segment
  // on the next one — persisting it risks silently skipping a real segment with no error at all.
  const TRANSLATE_CFG_STORE = 'wpml_translate_cfg';

  function initPanel() {
    if (typeof GM_addStyle !== 'function') return; // grant missing on this Tampermonkey install — skip rather than crash the rest of the script

    GM_addStyle(
      /* ---- glass panel shell — monochrome: no hue anywhere except pure black/white/grey ---- */
      '.wpml-helper-panel{--whp-text:#f0f0f0;--whp-dim:#9a9a9e;--whp-border:rgba(255,255,255,.10);' +
      'position:fixed;right:18px;bottom:18px;width:380px;max-height:82vh;display:flex;' +
      'flex-direction:column;overflow:hidden;color:var(--whp-text);' +
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'background:linear-gradient(160deg,rgba(40,40,42,.55),rgba(12,12,13,.8));' +
      'backdrop-filter:blur(18px) saturate(120%);-webkit-backdrop-filter:blur(18px) saturate(120%);' +
      'border:1px solid var(--whp-border);border-radius:14px;z-index:2147483000;' +
      'box-shadow:0 20px 44px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.05)}' +
      '.wpml-helper-panel *{box-sizing:border-box}' +
      '.wpml-helper-panel *::-webkit-scrollbar{width:8px;height:8px}' +
      '.wpml-helper-panel *::-webkit-scrollbar-track{background:transparent}' +
      '.wpml-helper-panel *::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:8px}' +
      '.wpml-helper-panel *::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.26)}' +
      '.wpml-helper-panel *{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}' +
      /* ---- header ---- */
      '.wpml-helper-panel .whp-header{flex:0 0 auto;display:flex;align-items:center;' +
      'justify-content:space-between;padding:10px 14px;' +
      'background:rgba(255,255,255,.04);border-bottom:1px solid var(--whp-border);' +
      'cursor:move;user-select:none}' +
      '.wpml-helper-panel .whp-title{font-weight:600;font-size:12.5px;letter-spacing:.02em;' +
      'color:var(--whp-text)}' +
      '.wpml-helper-panel .whp-collapse{width:22px;height:22px;border-radius:50%;' +
      'background:rgba(255,255,255,.08);border:1px solid var(--whp-border);color:var(--whp-text);' +
      'cursor:pointer;line-height:1;padding:0;transition:background .15s ease}' +
      '.wpml-helper-panel .whp-collapse:hover{background:rgba(255,255,255,.16)}' +
      /* ---- body / collapse animation ---- */
      '.wpml-helper-panel .whp-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 0 6px;' +
      'max-height:2000px;opacity:1;transition:max-height .25s ease,opacity .2s ease}' +
      '.wpml-helper-panel.whp-collapsed{max-height:none}' +
      '.wpml-helper-panel.whp-collapsed .whp-body{max-height:0;opacity:0;overflow:hidden}' +
      /* ---- sections ---- */
      '.wpml-helper-panel .whp-section{margin:0;padding:12px 14px;' +
      'border-bottom:1px solid rgba(255,255,255,.06)}' +
      '.wpml-helper-panel .whp-section:last-child{border-bottom:none}' +
      '.wpml-helper-panel .whp-section-title{font-weight:600;font-size:10.5px;letter-spacing:.08em;' +
      'text-transform:uppercase;color:var(--whp-dim);display:flex;align-items:center;' +
      'justify-content:space-between}' +
      /* ---- "?" help toggles: click reveals the one paragraph that used to sit here always-on ---- */
      '.wpml-helper-panel .whp-help{width:16px;height:16px;border-radius:50%;flex:0 0 auto;' +
      'background:rgba(255,255,255,.08);border:1px solid var(--whp-border);color:var(--whp-dim);' +
      'font-size:10px;line-height:1;display:inline-flex;align-items:center;justify-content:center;' +
      'cursor:pointer;padding:0;margin:0;text-transform:none;font-weight:600}' +
      '.wpml-helper-panel .whp-help:hover{background:rgba(255,255,255,.16);color:var(--whp-text)}' +
      '.wpml-helper-panel .whp-help-text{display:none;color:var(--whp-dim);font-size:10.5px;' +
      'line-height:1.5;margin-top:8px;background:rgba(255,255,255,.04);' +
      'border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:7px 9px}' +
      '.wpml-helper-panel .whp-help-text.whp-help-open{display:block}' +
      /* ---- advanced disclosure ---- */
      '.wpml-helper-panel .whp-advanced-toggle{display:block;width:100%;background:transparent;' +
      'border:1px dashed rgba(255,255,255,.14);color:var(--whp-dim);font-size:10.5px;' +
      'letter-spacing:.05em;margin:2px 0 0}' +
      '.wpml-helper-panel .whp-advanced-toggle:hover{color:var(--whp-text);' +
      'border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.04)}' +
      '.wpml-helper-panel .whp-advanced{max-height:2000px;opacity:1;overflow:hidden;' +
      'transition:max-height .25s ease,opacity .2s ease}' +
      '.wpml-helper-panel .whp-advanced.whp-advanced-closed{max-height:0;opacity:0}' +
      /* ---- inputs ---- */
      '.wpml-helper-panel label{display:block;margin:8px 0 0;color:var(--whp-dim);font-size:11px}' +
      '.wpml-helper-panel input,.wpml-helper-panel select{width:100%;margin-top:4px;padding:6px 8px;' +
      'background:rgba(255,255,255,.04);border:1px solid var(--whp-border);border-radius:7px;' +
      'color:var(--whp-text);font:inherit;transition:border-color .15s ease,background .15s ease}' +
      '.wpml-helper-panel input::placeholder{color:rgba(154,154,158,.6)}' +
      '.wpml-helper-panel input:focus,.wpml-helper-panel select:focus{outline:none;' +
      'border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.06)}' +
      '.wpml-helper-panel select{appearance:none;-webkit-appearance:none}' +
      /* ---- buttons: uniform neutral glass ---- */
      '.wpml-helper-panel button{background:rgba(255,255,255,.06);color:var(--whp-text);' +
      'border:1px solid var(--whp-border);border-radius:7px;padding:6px 10px;margin:8px 5px 0 0;' +
      'cursor:pointer;font:inherit;font-weight:500;transition:background .15s ease,' +
      'border-color .15s ease}' +
      '.wpml-helper-panel button:hover{background:rgba(255,255,255,.11);' +
      'border-color:rgba(255,255,255,.22)}' +
      '.wpml-helper-panel button:disabled{opacity:.4;cursor:default}' +
      /* ---- primary CTA: the one thing that should stand out, via contrast not hue ---- */
      '.wpml-helper-panel button.whp-translate-page-btn{display:block;width:100%;border:none;' +
      'background:#f0f0f0;color:#111;font-weight:600;font-size:12.5px;padding:9px 10px;' +
      'margin:10px 0 0;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);' +
      'transition:background .15s ease,box-shadow .15s ease}' +
      '.wpml-helper-panel button.whp-translate-page-btn:hover{background:#fff;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.45)}' +
      '.wpml-helper-panel button.whp-translate-page-btn:disabled{opacity:.4;box-shadow:none}' +
      /* ---- inset blocks (status/log/preview) ---- */
      '.wpml-helper-panel pre.whp-status,.wpml-helper-panel .whp-errorlog,' +
      '.wpml-helper-panel .whp-preview{' +
      'background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.06);border-radius:7px;' +
      'padding:8px;margin-top:8px}' +
      '.wpml-helper-panel pre.whp-status{white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace;' +
      'color:var(--whp-dim)}' +
      '.wpml-helper-panel .whp-errorlog{white-space:pre-wrap;max-height:150px;overflow-y:auto;' +
      'font:11px/1.5 ui-monospace,monospace;color:var(--whp-dim)}' +
      '.wpml-helper-panel .whp-preview{max-height:220px;overflow:auto}' +
      /* ---- text ---- */
      '.wpml-helper-panel .whp-hint{color:var(--whp-dim);font-size:10px;line-height:1.5;margin-top:5px}' +
      '.wpml-helper-panel .whp-keys-status{color:var(--whp-dim);font-size:11px;margin-top:6px}' +
      '.wpml-helper-panel .whp-action-result,.wpml-helper-panel .whp-translate-result,' +
      '.wpml-helper-panel .whp-translate-page-result{white-space:pre-wrap;margin-top:8px;' +
      'color:var(--whp-text);font-size:11px;line-height:1.5}' +
      /* ---- preview table ---- */
      '.wpml-helper-panel table.whp-preview-table{width:100%;border-collapse:collapse;font-size:10.5px}' +
      '.wpml-helper-panel table.whp-preview-table th,.wpml-helper-panel table.whp-preview-table td{' +
      'border-bottom:1px solid rgba(255,255,255,.07);padding:5px 6px;text-align:left;' +
      'vertical-align:top;word-break:break-word}' +
      '.wpml-helper-panel table.whp-preview-table th{background:rgba(255,255,255,.04);' +
      'position:sticky;top:0;color:var(--whp-dim);font-weight:600;text-transform:uppercase;' +
      'font-size:9.5px;letter-spacing:.05em}' +
      /* ---- divider ---- */
      '.wpml-helper-panel hr{border:none;height:1px;margin:12px 0;background:rgba(255,255,255,.10)}'
    );

    const panel = document.createElement('div');
    panel.className = 'wpml-helper-panel';
    panel.innerHTML =
      '<div class="whp-header"><span class="whp-title">WPML Helper</span>' +
      '<button class="whp-collapse" type="button" title="Collapse">–</button></div>' +
      '<div class="whp-body">' +
        '<div class="whp-section">' +
          '<div class="whp-section-title"><span>API Keys</span>' +
          '<button type="button" class="whp-help">?</button></div>' +
          '<div class="whp-help-text">Pick a provider, paste its API key, Save. The key is remembered ' +
          '(Tampermonkey storage); the provider choice itself is not — it resets to Gemini on reload.</div>' +
          '<label>Provider<select class="whp-provider"><option value="gemini">Gemini</option>' +
          '<option value="claude">Claude</option><option value="openai">OpenAI</option></select></label>' +
          '<label>Key<input type="password" class="whp-key-input" placeholder="paste key here" autocomplete="off"></label>' +
          '<button class="whp-save-keys" type="button">Save</button>' +
          '<div class="whp-keys-status"></div>' +
        '</div>' +
        '<div class="whp-section">' +
          '<div class="whp-section-title"><span>Translate</span>' +
          '<button type="button" class="whp-help">?</button></div>' +
          '<div class="whp-help-text">Extracts every segment, auto-excludes any segment whose text ' +
          'contains "focus keyword", then translates batch 1 and pauses here for you to review. Click ' +
          'again (now "Approve &amp; Finish") to write + verify the rest.</div>' +
          '<label>Target language<select class="whp-target-lang-select"><option value="">Custom (type below)…</option>' +
          '<option>Spanish</option><option>French</option><option>German</option><option>Portuguese</option>' +
          '<option>Italian</option><option>Dutch</option><option>Polish</option><option>Turkish</option>' +
          '<option>Russian</option><option>Arabic</option><option>Chinese (Simplified)</option>' +
          '<option>Japanese</option><option>Korean</option><option>Vietnamese</option><option>Hindi</option>' +
          '</select></label>' +
          '<input type="text" class="whp-target-lang" placeholder="or type a language/code here" autocomplete="off">' +
          '<button type="button" class="whp-translate-page-btn">Translate Page</button>' +
          '<div class="whp-translate-page-result"></div>' +
          '<div class="whp-preview"></div>' +
        '</div>' +
        '<button type="button" class="whp-advanced-toggle">Advanced ▾</button>' +
        '<div class="whp-advanced whp-advanced-closed">' +
          '<div class="whp-section">' +
            '<div class="whp-section-title">Manual translate</div>' +
            '<div class="whp-hint">Only needed if auto-exclude misses or over-matches — uses the ' +
            'Target language above. Get an index from wpml.read() in the console.</div>' +
            '<label>Exclude indices<input type="text" class="whp-exclude" placeholder="e.g. 137, 45" autocomplete="off"></label>' +
            '<button type="button" class="whp-translate-btn">Translate (batch 1 only)</button>' +
            '<div class="whp-translate-result"></div>' +
          '</div>' +
          '<div class="whp-section">' +
            '<div class="whp-section-title">Queue / Status</div>' +
            '<pre class="whp-status"></pre>' +
          '</div>' +
          '<div class="whp-section">' +
            '<div class="whp-section-title">Actions</div>' +
            '<button type="button" data-action="extract">Extract</button>' +
            '<button type="button" data-action="verify">Verify</button>' +
            '<button type="button" data-action="vprog">Verify Status</button>' +
            '<button type="button" data-action="approve">Approve</button>' +
            '<button type="button" data-action="retryFailed">Retry Failed</button>' +
            '<div class="whp-action-result"></div>' +
          '</div>' +
          '<div class="whp-section">' +
            '<div class="whp-section-title">Error Log (last ' + MAX_ERROR_LOG + ')</div>' +
            '<div class="whp-errorlog"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    const header = panel.querySelector('.whp-header');
    const collapseBtn = panel.querySelector('.whp-collapse');
    const advancedToggle = panel.querySelector('.whp-advanced-toggle');
    const advancedEl = panel.querySelector('.whp-advanced');
    const providerSel = panel.querySelector('.whp-provider');
    const keyInput = panel.querySelector('.whp-key-input');
    const keysStatusEl = panel.querySelector('.whp-keys-status');
    const targetLangSelect = panel.querySelector('.whp-target-lang-select');
    const targetLangInput = panel.querySelector('.whp-target-lang');
    const translatePageBtn = panel.querySelector('.whp-translate-page-btn');
    const translatePageResultEl = panel.querySelector('.whp-translate-page-result');
    const excludeInput = panel.querySelector('.whp-exclude');
    const translateBtn = panel.querySelector('.whp-translate-btn');
    const translateResultEl = panel.querySelector('.whp-translate-result');
    const previewEl = panel.querySelector('.whp-preview');
    const statusEl = panel.querySelector('.whp-status');
    const actionResultEl = panel.querySelector('.whp-action-result');
    const errorLogEl = panel.querySelector('.whp-errorlog');

    const savedTranslateCfg = GM_getValue(TRANSLATE_CFG_STORE, null) || {};
    targetLangInput.value = savedTranslateCfg.targetLang || 'Spanish'; // Spanish preselected by default
    // if the current value matches one of the preset options, reflect that in the dropdown too;
    // otherwise it's a custom value the dropdown can't represent, so leave it on "Custom"
    if (Array.from(targetLangSelect.options).some((o) => o.value === targetLangInput.value)) {
      targetLangSelect.value = targetLangInput.value;
    }
    targetLangSelect.addEventListener('change', () => {
      if (targetLangSelect.value) targetLangInput.value = targetLangSelect.value;
    });
    // exclude is intentionally left blank on load — see the note by TRANSLATE_CFG_STORE above

    const saved = GM_getValue(PANEL_STATE_STORE, null) || {};
    let collapsed = !!saved.collapsed;
    let advancedOpen = !!saved.advancedOpen;
    if (saved.left && saved.top) {
      panel.style.left = saved.left;
      panel.style.top = saved.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function persistPanelState() {
      GM_setValue(PANEL_STATE_STORE, { left: panel.style.left || null, top: panel.style.top || null, collapsed, advancedOpen });
    }

    // Single key field bound to whichever provider is selected in the dropdown — matches the
    // console's own setKey() semantics ("stores for the CURRENTLY configured provider") instead of
    // showing all three providers' inputs at once.
    function renderKeyStatus() {
      const p = providerSel.value;
      const has = !!GM_getValue(KEY_STORES[p], null);
      const label = p.charAt(0).toUpperCase() + p.slice(1);
      keyInput.placeholder = has ? 'saved — leave blank to keep' : 'paste key here';
      keysStatusEl.textContent = label + ' key: ' + (has ? 'saved' : 'not set');
    }

    function renderStatus() {
      const ai = api.ai.status();
      const q = api.prog();
      statusEl.textContent =
        'provider: ' + ai.provider + '  model: ' + ai.model + '\n' +
        'running: ' + ai.running + '  awaitingApproval: ' + ai.awaitingApproval + '\n' +
        'batches: ' + ai.batchesDone + '/' + ai.batchesTotal + '  translated: ' + ai.translated +
        '  failed: ' + Object.keys(ai.failed).length + '\n' +
        'lastError: ' + (ai.lastError || '(none)') + '\n' +
        '--- segment queue ---\n' +
        'active: ' + q.active + '  queued: ' + q.queue + '  done: ' + q.done + '/' + q.total +
        (q.err ? ('  err: ' + q.err) : '');
    }

    function renderErrorLog() {
      const log = api.ai.errorLog();
      errorLogEl.textContent = log.length
        ? log.slice().reverse().map((e) => new Date(e.t).toLocaleTimeString() + ' — ' + e.label + ': ' + e.detail).join('\n\n')
        : '(none yet)';
    }

    // Renders the exact same {i, source, translated, linkTexts} rows aiPreview() already
    // console.table's — built via createElement/textContent (never innerHTML) since cell content
    // is arbitrary translated text, not markup meant to be rendered.
    function renderPreview() {
      const rows = api.ai.previewRows();
      previewEl.textContent = '';
      if (!rows.length) return;
      const table = document.createElement('table');
      table.className = 'whp-preview-table';
      const headRow = document.createElement('tr');
      ['i', 'source', 'translated', 'linkTexts'].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        headRow.appendChild(th);
      });
      table.appendChild(headRow);
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        [r.i, r.source, r.translated, r.linkTexts].forEach((v) => {
          const td = document.createElement('td');
          td.textContent = String(v);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      previewEl.appendChild(table);
    }

    function parseExcludeInput(raw) {
      return raw
        ? raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n))
        : [];
    }

    // Polls a state.*Job reference (extractJob/vJob) until a NEW job object (not whatever was
    // left over from a prior run) reports done — extract()/verify() both return immediately while
    // their real work happens in a background IIFE, so "just check .done" alone would race a stale
    // job left over from an earlier call in the same session.
    function waitForNewJobDone(getJob, prevJob, timeoutMs) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
          const j = getJob();
          if (j && j !== prevJob && j.done) { clearInterval(iv); resolve(j); }
          else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timed out waiting')); }
        }, 400);
      });
    }

    // approve() resolving only means every AI batch got translated and handed to queue() — each
    // queue() call fires drain() without awaiting it, so the actual DOM writes (scroll to segment,
    // open editor, splice content, save) can still be running well after approve()'s promise
    // settles. Calling verify() before drain() is idle would scroll-scan a page mid-edit AND risk
    // two things fighting over the same scroller/tinymce state at once.
    function waitForDrainIdle(timeoutMs) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
          if (!state.run.active && state.q.length === 0) { clearInterval(iv); resolve(); }
          else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timed out waiting for segment queue to drain')); }
        }, 400);
      });
    }

    // A 429 retry backs off 15s/30s/60s (~105s worst case, see retryDelayMs above) entirely inside
    // one awaited call — with nothing shown while it's happening, that looks identical to "stuck".
    // Polls the same errorLog() the Error Log section reads and appends each new entry as it lands.
    function pollRetryFeedback(targetEl) {
      let lastSeen = 0;
      const log0 = api.ai.errorLog();
      if (log0.length) lastSeen = log0[log0.length - 1].t;
      const iv = setInterval(() => {
        const log = api.ai.errorLog();
        const last = log[log.length - 1];
        if (last && last.t !== lastSeen) {
          lastSeen = last.t;
          targetEl.textContent += '\n(retrying — ' + last.label + ')';
        }
      }, 400);
      return () => clearInterval(iv);
    }

    // A long AI call (measured live: ~69s for a 25-segment Gemini batch) otherwise shows zero
    // feedback and looks hung. Owns one child element inside targetEl so it never collides with
    // pollRetryFeedback's targetEl.textContent += above — that assignment nukes all child nodes
    // (textContent, not innerHTML), so the tick re-appends its element if it ever gets wiped that way.
    function startElapsedTicker(targetEl) {
      const start = Date.now();
      const el = document.createElement('div');
      el.className = 'whp-elapsed-tick';
      const render = () => {
        if (!el.isConnected) targetEl.appendChild(el);
        el.textContent = Math.round((Date.now() - start) / 1000) + 's elapsed…';
      };
      render();
      const iv = setInterval(render, 1000);
      return () => { clearInterval(iv); el.remove(); };
    }

    let translatePagePhase = 1;
    function setTranslatePagePhase(n) {
      translatePagePhase = n;
      translatePageBtn.textContent = n === 1 ? 'Translate Page' : 'Approve & Finish';
    }

    // One-click chain: extract -> auto-exclude any "focus keyword" segment -> translate batch 1.
    // Pauses there (same built-in checkpoint the plain Translate button stops at) — the SAME
    // button then reads as "Approve & Finish" for the second click, which approves the rest and
    // auto-verifies. Every step below calls an existing api.*/api.ai.* method; nothing new is
    // invented except the auto-exclude text match and the wait/phase bookkeeping around them.
    translatePageBtn.addEventListener('click', async () => {
      translatePageBtn.disabled = true;
      try {
        if (translatePagePhase === 1) {
          const targetLang = targetLangInput.value.trim();
          GM_setValue(TRANSLATE_CFG_STORE, { targetLang });
          translatePageResultEl.textContent = 'Extracting…';
          const prevExtractJob = state.extractJob;
          api.extract();
          await waitForNewJobDone(() => state.extractJob, prevExtractJob, 90000);
          const segs = api.read();
          const autoExclude = segs.filter((s) => /focus\s*keyword/i.test(s.tp || '')).map((s) => s.i);
          excludeInput.value = autoExclude.join(', ');
          translatePageResultEl.textContent = autoExclude.length
            ? 'Auto-excluded #' + autoExclude.join(', #') + ' (matched "focus keyword"). Translating batch 1…'
            : 'No "focus keyword" segment matched — excluding nothing. Translating batch 1…';
          api.ai.config({ targetLang: targetLang || null, exclude: autoExclude });
          const stopFeedback = pollRetryFeedback(translatePageResultEl);
          const stopTicker = startElapsedTicker(translatePageResultEl);
          const result = await api.ai.translate().finally(() => { stopFeedback(); stopTicker(); });
          translatePageResultEl.textContent += '\n' + result;
          renderPreview();
          if (api.ai.status().awaitingApproval) setTranslatePagePhase(2);
        } else {
          translatePageResultEl.textContent = 'Approving remaining batches…';
          const stopFeedback = pollRetryFeedback(translatePageResultEl);
          const stopTicker = startElapsedTicker(translatePageResultEl);
          const approveResult = await api.ai.approve().finally(() => { stopFeedback(); stopTicker(); });
          translatePageResultEl.textContent += '\n' + approveResult;
          if (api.ai.status().lastError) {
            // stays on phase 2 — clicking "Approve & Finish" again resumes from the failed batch (v1.4 behavior)
            return;
          }
          translatePageResultEl.textContent += '\n\nFinishing queued writes…';
          await waitForDrainIdle(120000);
          translatePageResultEl.textContent += '\n\nVerifying…';
          const prevVJob = state.vJob;
          api.verify();
          await waitForNewJobDone(() => state.vJob, prevVJob, 90000);
          const v = api.vprog();
          const clean = !v.missing.length && !v.english.length && !v.markerLost.length;
          translatePageResultEl.textContent = approveResult +
            '\n\nVerify: missing=' + v.missing.length + ' english=' + v.english.length + ' markerLost=' + v.markerLost.length +
            (clean ? '\n(all clean)' : '\n(needs manual cleanup — see wpml.vprog() / Actions for details)');
          setTranslatePagePhase(1);
        }
      } catch (e) {
        translatePageResultEl.textContent = 'Error: ' + e.message;
      } finally {
        translatePageBtn.disabled = false;
        renderStatus();
        renderErrorLog();
      }
    });

    let pollTimer = null;
    function tick() {
      if (document.hidden || !advancedOpen) return; // backgrounded tab, or the section showing this is closed — skip
      renderStatus();
      renderErrorLog();
    }
    function startPolling() {
      if (pollTimer) return;
      tick();
      pollTimer = setInterval(tick, 1500);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function applyCollapsed() {
      panel.classList.toggle('whp-collapsed', collapsed);
      collapseBtn.textContent = collapsed ? '+' : '–';
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
      if (collapsed) stopPolling(); else startPolling();
    }

    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      applyCollapsed();
      persistPanelState();
    });

    // Advanced holds everything not needed for the core "translate the page" flow (manual
    // exclude override, extract/verify/approve/retryFailed actions, detailed status, error log) —
    // closed by default so the main view only shows keys + target language + the one CTA.
    function applyAdvanced() {
      advancedEl.classList.toggle('whp-advanced-closed', !advancedOpen);
      advancedToggle.textContent = advancedOpen ? 'Advanced ▲' : 'Advanced ▾';
      tick(); // catch up the now-visible status/error-log immediately instead of waiting for the next poll
    }

    advancedToggle.addEventListener('click', () => {
      advancedOpen = !advancedOpen;
      applyAdvanced();
      persistPanelState();
    });

    // "?" toggles: each sits right after a .whp-section-title, immediately followed by its
    // .whp-help-text — generic wiring, no per-button data needed.
    panel.querySelectorAll('.whp-help').forEach((btn) => {
      const textEl = btn.closest('.whp-section-title').nextElementSibling;
      btn.addEventListener('click', () => textEl.classList.toggle('whp-help-open'));
    });

    // drag-to-reposition, header only (not the collapse button)
    let dragging = false, dragOffX = 0, dragOffY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target === collapseBtn) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dragOffX) + 'px';
      panel.style.top = (e.clientY - dragOffY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      persistPanelState();
    });

    // Writes straight to KEY_STORES[provider] — the same constant setKey() itself uses — for
    // whichever provider is currently selected in the dropdown, same semantics as console setKey().
    // Applies the moment you pick it — a dropdown that visually shows a selection but silently
    // needs a separate Save click to actually take effect is exactly how a real run quietly kept
    // using Gemini while OpenAI looked selected and "saved" in the UI.
    providerSel.addEventListener('change', () => {
      api.ai.config({ provider: providerSel.value });
      renderKeyStatus();
      renderStatus();
    });
    panel.querySelector('.whp-save-keys').addEventListener('click', () => {
      const kv = keyInput.value.trim();
      if (kv) GM_setValue(KEY_STORES[providerSel.value], kv);
      api.ai.config({ provider: providerSel.value });
      keyInput.value = '';
      renderKeyStatus();
      renderStatus();
    });

    // wpml.ai.translate() takes no arguments — targetLang/exclude are set beforehand via
    // wpml.ai.config({targetLang, exclude}), which is what this does before calling translate().
    translateBtn.addEventListener('click', async () => {
      const targetLang = targetLangInput.value.trim();
      const excludeRaw = excludeInput.value.trim();
      GM_setValue(TRANSLATE_CFG_STORE, { targetLang }); // exclude not persisted — see note above
      translateBtn.disabled = true;
      translateResultEl.textContent = '';
      previewEl.textContent = '';
      const stopFeedback = pollRetryFeedback(translateResultEl);
      const stopTicker = startElapsedTicker(translateResultEl);
      try {
        api.ai.config({ targetLang: targetLang || null, exclude: parseExcludeInput(excludeRaw) });
        const result = await api.ai.translate();
        translateResultEl.textContent += result;
        renderPreview();
      } catch (e) {
        translateResultEl.textContent += 'Error: ' + e.message;
      } finally {
        stopFeedback();
        stopTicker();
        translateBtn.disabled = false;
        renderStatus();
      }
    });

    panel.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        btn.disabled = true;
        const stopFeedback = pollRetryFeedback(actionResultEl);
        const stopTicker = startElapsedTicker(actionResultEl);
        try {
          let result;
          if (action === 'extract') result = api.extract();
          else if (action === 'verify') result = api.verify();
          else if (action === 'vprog') result = api.vprog();
          else if (action === 'approve') result = await api.ai.approve();
          else if (action === 'retryFailed') result = await api.ai.retryFailed();
          actionResultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
        } catch (e) {
          actionResultEl.textContent = 'Error: ' + e.message;
        } finally {
          stopFeedback();
          stopTicker();
          btn.disabled = false;
          renderStatus();
        }
      });
    });

    providerSel.value = state.ai.config.provider;
    renderKeyStatus();
    applyAdvanced();
    applyCollapsed();
  }

  initPanel();
})();
