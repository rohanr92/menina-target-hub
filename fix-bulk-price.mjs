import fs from 'node:fs';
const f = 'public/app.js';
let s = fs.readFileSync(f, 'utf8');
const reps = [
 [
  "    <div class=\"row\"><label class=\"switch\" style=\"margin:0\"><input type=\"checkbox\" id=\"allpub\" />",
  "    <div class=\"row\" style=\"margin-bottom:12px;gap:8px\"><b style=\"font-size:14px\">Price for all ${ds.length}:</b>\n      <input type=\"number\" step=\"0.01\" id=\"allbin\" placeholder=\"Buy it now $\" style=\"width:140px\" />\n      <input type=\"number\" step=\"0.01\" id=\"allauc\" placeholder=\"Auction start $\" style=\"width:150px\" />\n      <button class=\"btn\" id=\"allset\" type=\"button\">Apply to all</button></div>\n    <div class=\"row\"><label class=\"switch\" style=\"margin:0\"><input type=\"checkbox\" id=\"allpub\" />"
 ],
 [
  "  $('#allpub').onchange = (e) => document.querySelectorAll('[data-pub]').forEach((x) => { x.checked = e.target.checked; });",
  "  $('#allpub').onchange = (e) => document.querySelectorAll('[data-pub]').forEach((x) => { x.checked = e.target.checked; });\n  $('#allset').onclick = () => {\n    const b = $('#allbin').value, a = $('#allauc').value;\n    if (!b && !a) return toast('Type a Buy it now or Auction price first', 'bad');\n    if (b) document.querySelectorAll('.vbin').forEach((x) => { x.value = Number(b).toFixed(2); });\n    if (a) document.querySelectorAll('.vauc').forEach((x) => { x.value = Number(a).toFixed(2); });\n    toast(`Price set on every size of all ${imp.drafts.length} listings`, 'ok');\n  };"
 ],
 [
  "  if (problems.length) return toast(`${problems.length} listing(s) need a category and a ${'price on every variant'} for the chosen sale format`, 'bad');",
  "  if (problems.length) return toast(`${problems.length} listing(s) can't be created yet: ` + problems.slice(0, 3).map((d) => `${d.title} (${!d.category_id ? 'no category' : d.sale_format === 'auction' ? 'needs an Auction start price' : 'needs a Buy it now price'})`).join('; ') + (problems.length > 3 ? '…' : '') + ' — use \"Price for all\" at the top.', 'bad');"
 ]
];
let n = 0;
for (const [a, b] of reps) { if (s.includes(b)) { n++; continue; } if (!s.includes(a)) { console.log('NOT FOUND:', a.slice(0, 70)); continue; } s = s.replace(a, () => b); n++; }
fs.writeFileSync(f, s);
console.log(n === reps.length ? 'PATCH OK (' + n + '/' + reps.length + ')' : 'PATCH INCOMPLETE ' + n + '/' + reps.length);
