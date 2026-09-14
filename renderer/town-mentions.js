'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.beingTownMentions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const clean = (value, limit = 100) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
  function candidates(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 100).filter(item => validId(item?.town_id) && !seen.has(item.town_id) && seen.add(item.town_id))
      .map(item => ({town_id: item.town_id, display_name: clean(item.display_name) || item.town_id}));
  }
  const memberId = member => member?.townId || member?.town_id || member?.id || member?.being_id || member?.beingId || '';
  const memberName = member => member?.displayName || member?.display_name || member?.name || '';
  function memberMap(members) {
    const result = new Map();
    for (const member of Array.isArray(members) ? members : []) if (validId(memberId(member))) result.set(memberId(member), member);
    return result;
  }
  // Typed names resolve as complete single-token references. Picker selections
  // carry exact ranges and IDs, allowing display names with spaces or duplicates.
  function resolve(text, members, selections = []) {
    const byId = memberMap(members), values = [...byId.values()];
    const mentions = new Set(), ambiguous = [], unresolved = [], replacements = [];
    const protectedRanges = [];
    for (const selection of selections) {
      const {start, end, id, label} = selection;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || !byId.has(id)
        || typeof label !== 'string' || text.slice(start, end) !== '@' + label
        || start > 0 && !/\s/u.test(text[start - 1]) || end < text.length && !/[\s.,!?;:，。！？；：、()\[\]{}]/u.test(text[end])
        || protectedRanges.some(range => start < range.end && end > range.start)) continue;
      protectedRanges.push({start, end}); mentions.add(id); replacements.push({start, end, text: '@' + id});
    }
    for (const match of text.matchAll(/(^|\s)@([^\s@/.,!?;:，。！？；：、()\[\]{}]{1,100})(?=$|[\s.,!?;:，。！？；：、()\[\]{}])/gu)) {
      const query = match[2], start = match.index + match[1].length, end = start + query.length + 1;
      if (protectedRanges.some(range => start < range.end && end > range.start)) continue;
      const matches = byId.has(query) ? [byId.get(query)] : values.filter(member => memberName(member) === query);
      if (matches.length === 1) {
        const id = memberId(matches[0]); mentions.add(id);
        replacements.push({start, end, text: '@' + id});
      } else if (matches.length > 1) ambiguous.push({start, end, query, candidates: matches});
      else unresolved.push(query);
    }
    let addressed = text;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) addressed = addressed.slice(0, replacement.start) + replacement.text + addressed.slice(replacement.end);
    return {text: addressed, members: [...mentions], ambiguous, unresolved: [...new Set(unresolved)]};
  }
  // Keep a picked name tied to its ID while surrounding text changes. Editing the
  // name itself removes that binding and lets normal name resolution take over.
  function rebaseSelections(before, after, selections) {
    if (before === after) return selections;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
    while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const oldEnd = before.length - suffix, delta = after.length - before.length;
    return selections.flatMap(selection => selection.end <= prefix ? [selection]
      : selection.start >= oldEnd ? [{...selection, start:selection.start + delta, end:selection.end + delta}] : []);
  }
  // Display-only projection: canonical message bytes remain unchanged in history
  // and on the wire. Call after Markdown parsing so names are always inert text.
  function displayText(text, members) {
    const byId = memberMap(members);
    return String(text || '').replace(/(?:https?:\/\/|mailto:)\S+|(^|[\s，。！？；：、（【“‘(\[{])@([A-Za-z0-9][A-Za-z0-9_-]{0,99})(?=$|[\s.,!?;:，。！？；：、()\[\]{}）】”’])/gu,
      (whole, before, id) => { const name = id && clean(memberName(byId.get(id))); return name ? before + '@' + name : whole; });
  }
  function warnings(value) {
    return (Array.isArray(value) ? value : []).slice(0, 100).map(item => {
      if (typeof item === 'string') return {mention: '', detail: clean(item, 500), candidates: []};
      return {mention: clean(item?.mention || item?.name || item?.query || item?.token || item?.input), detail: clean(item?.message || item?.reason || item?.warning, 500), candidates: candidates(item?.candidates)};
    });
  }
  function renderReceipt(target, receipt, publication = '消息已发布。') {
    const doc = target.ownerDocument;
    const node = (tag, text) => { const el = doc.createElement(tag); el.textContent = text; return el; };
    target.replaceChildren(node('p', publication)); target.hidden = false;
    target.dataset.published = 'true';
    const problems = warnings(receipt?.mention_warnings);
    if (receipt?.mentions?.length) target.append(node('p', `Town 已接受提及通知：${receipt.mentions.map(id => '@' + clean(id)).join('、')}`));
    if (!problems.length) return;
    const list = doc.createElement('ul'); list.setAttribute('aria-label', '提及警告');
    for (const warning of problems) {
      const row = node('li', warning.candidates.length ? `提及有歧义${warning.mention ? '：' + warning.mention : ''}` : `提及未确认${warning.mention ? '：' + warning.mention : ''}${warning.detail ? ' · ' + warning.detail : ''}`);
      if (warning.candidates.length) {
        const choices = doc.createElement('ul');
        for (const choice of warning.candidates) choices.append(node('li', `${choice.display_name} · ${choice.town_id}`));
        row.append(choices);
      }
      list.append(row);
    }
    target.append(list);
  }
  const isOwnMessage = (sender, identity) => validId(identity?.townId) && sender === identity.townId;
  return {isOwnMessage, candidates, memberId, memberName, memberMap, resolve, rebaseSelections, displayText, warnings, renderReceipt};
});
