
import {
  renderDeckInputSchema,
  resolveLayout,
  type RenderDeckInput,
  type DeckSlide,
} from "./deck-schema";
import { DEFAULT_DECK_THEME, type DeckTheme } from "./brand-theme";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bulletList(items: string[]): string {
  return `<ul>${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
}

export function renderSlideBody(slide: DeckSlide, index: number): string {
  const layout = resolveLayout(slide, index);
  const sub = slide.subheading ? `<p class="sub">${esc(slide.subheading)}</p>` : "";
  const body = slide.body ? `<p class="body">${esc(slide.body)}</p>` : "";

  switch (layout) {
    case "title":
      return `<div class="pad center"><div class="eyebrow"></div><h1 class="t">${esc(slide.heading)}</h1>${sub}${body}</div>`;
    case "statement":
      return `<div class="pad center"><h2 class="st">${esc(slide.heading)}</h2>${sub}${body}</div>`;
    case "metrics": {
      const cells = (slide.metrics ?? [])
        .map(
          (m) =>
            `<div class="metric"><div class="mv">${esc(m.value)}</div><div class="ml">${esc(m.label)}</div></div>`,
        )
        .join("");
      return `<div class="pad"><h2>${esc(slide.heading)}</h2>${sub}${body}<div class="metrics n${(slide.metrics ?? []).length}">${cells}</div></div>`;
    }
    case "two_column": {
      const cols = (slide.columns ?? [])
        .map(
          (c) => `<div class="col"><h3>${esc(c.heading)}</h3>${bulletList(c.bullets)}</div>`,
        )
        .join("");
      return `<div class="pad"><h2>${esc(slide.heading)}</h2>${sub}${body}<div class="cols">${cols}</div></div>`;
    }
    case "bullets":
    default:
      return `<div class="pad"><h2>${esc(slide.heading)}</h2>${sub}${body}${
        slide.bullets && slide.bullets.length ? bulletList(slide.bullets) : ""
      }</div>`;
  }
}

export function renderDeckHtml(
  rawInput: unknown,
  theme: DeckTheme = DEFAULT_DECK_THEME,
): string {
  const input: RenderDeckInput = renderDeckInputSchema.parse(rawInput);

  const slides = input.slides
    .map((s, i) => {
      const notes = s.notes
        ? `<div class="notes" hidden>${esc(s.notes)}</div>`
        : `<div class="notes" hidden></div>`;
      return `<section class="slide" data-i="${i}"${i === 0 ? "" : " hidden"}>${renderSlideBody(s, i)}${
        input.footer ? `<div class="foot">${esc(input.footer)}</div>` : ""
      }<div class="num">${i + 1} / ${input.slides.length}</div>${notes}</section>`;
    })
    .join("\n");

  const dots = input.slides
    .map((_, i) => `<button class="dot" data-g="${i}" aria-label="Slide ${i + 1}"></button>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%;background:${theme.creamDeep};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    color:${theme.ink};-webkit-font-smoothing:antialiased}
  #stage{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:10px}
  #deck{width:100%;max-width:1120px;aspect-ratio:16/9;position:relative;
    background:${theme.cream};border:1px solid ${theme.rule};border-radius:14px;
    box-shadow:0 10px 30px rgba(25,25,25,.10);overflow:hidden}
  .slide{position:absolute;inset:0;display:flex;flex-direction:column}
  .slide[hidden]{display:none}
  .pad{flex:1;display:flex;flex-direction:column;justify-content:flex-start;
    padding:clamp(24px,4.4%,56px) clamp(28px,5.2%,68px)}
  .pad.center{justify-content:center;text-align:center;align-items:center}
  .eyebrow{width:64px;height:5px;border-radius:3px;background:${theme.gold};margin-bottom:22px}
  h1.t{font-size:clamp(26px,4.6vw,52px);line-height:1.08;letter-spacing:-.02em;margin:0;font-weight:800;max-width:16ch}
  h2,h2.st{font-size:clamp(20px,3.1vw,36px);line-height:1.15;letter-spacing:-.015em;margin:0 0 6px;font-weight:750}
  h2.st{max-width:20ch;font-size:clamp(22px,3.6vw,42px)}
  h2:not(.st){padding-bottom:12px;border-bottom:2px solid ${theme.accent};display:inline-block}
  h3{font-size:clamp(13px,1.5vw,17px);margin:0 0 8px;font-weight:750;color:${theme.accent};
    text-transform:uppercase;letter-spacing:.06em}
  .sub{font-size:clamp(13px,1.7vw,20px);color:${theme.inkMuted};margin:10px 0 0;line-height:1.4;max-width:52ch}
  .body{font-size:clamp(13px,1.5vw,18px);line-height:1.55;margin:14px 0 0;max-width:60ch}
  ul{margin:18px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:clamp(7px,1.1vh,14px)}
  /* Vertical balance — mirrors blockTop() in render-deck-pdf.ts. A slide's
     content block drops a bounded amount below the heading instead of hugging
     it (top-heavy) or centering (detached). Keep these in step with the PDF. */
  .pad > ul{margin-top:clamp(16px,5%,46px)}
  li{position:relative;padding-left:26px;font-size:clamp(13px,1.55vw,19px);line-height:1.45}
  li::before{content:"";position:absolute;left:4px;top:.55em;width:8px;height:8px;border-radius:50%;background:${theme.accent}}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:clamp(20px,3.4%,44px);margin-top:clamp(16px,4.5%,42px)}
  .col ul{margin-top:10px}
  .metrics{display:grid;gap:clamp(14px,2.4%,32px);margin-top:clamp(20px,7%,60px);margin-bottom:auto}
  .metrics.n1{grid-template-columns:1fr}.metrics.n2{grid-template-columns:repeat(2,1fr)}
  .metrics.n3{grid-template-columns:repeat(3,1fr)}.metrics.n4{grid-template-columns:repeat(4,1fr)}
  .metric{background:${theme.creamDeep};border:1px solid ${theme.rule};border-radius:12px;padding:clamp(12px,2%,22px)}
  .mv{font-size:clamp(24px,3.9vw,46px);font-weight:800;letter-spacing:-.02em;line-height:1}
  .ml{font-size:clamp(11px,1.15vw,14px);color:${theme.inkMuted};margin-top:8px;line-height:1.35}
  .foot{position:absolute;left:clamp(28px,5.2%,68px);bottom:16px;font-size:11px;color:${theme.inkMuted}}
  .num{position:absolute;right:clamp(28px,5.2%,68px);bottom:16px;font-size:11px;color:${theme.inkMuted};
    font-variant-numeric:tabular-nums}
  .notes{position:absolute;left:0;right:0;bottom:0;background:${theme.ink};color:${theme.cream};
    padding:14px 20px;font-size:13px;line-height:1.5;max-height:38%;overflow:auto}
  #bar{width:100%;max-width:1120px;display:flex;align-items:center;gap:12px}
  #prog{flex:1;height:4px;background:${theme.rule};border-radius:2px;overflow:hidden}
  #prog span{display:block;height:100%;background:${theme.accent};width:0;transition:width .18s ease}
  #dots{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
  .dot{width:8px;height:8px;padding:0;border:0;border-radius:50%;background:${theme.rule};cursor:pointer}
  .dot.on{background:${theme.ink}}
  #hint{font-size:11px;color:${theme.inkMuted};text-align:center}
  #nav{position:absolute;inset:0;display:flex}
  #nav button{flex:1;background:transparent;border:0;cursor:pointer;opacity:0}
  @media print{
    html,body{background:#fff}
    #stage{display:block;padding:0}#bar,#hint,#dots{display:none}
    #deck{max-width:none;width:100%;aspect-ratio:auto;border:0;border-radius:0;box-shadow:none;position:static}
    .slide{position:static;display:flex!important;height:100vh;page-break-after:always;break-after:page}
    .slide[hidden]{display:flex!important}
    .notes{display:none!important}
    #nav{display:none}
    @page{size:landscape;margin:0}
  }
</style></head>
<body>
<div id="stage">
  <div id="deck">
${slides}
    <div id="nav"><button id="p" aria-label="Previous slide"></button><button id="n" aria-label="Next slide"></button></div>
  </div>
  <div id="bar"><div id="prog"><span id="fill"></span></div><div id="dots">${dots}</div></div>
  <div id="hint">← → to move · N for notes · F for fullscreen · Print for PDF</div>
</div>
<script>
(function(){
  var S=[].slice.call(document.querySelectorAll('.slide'));
  var D=[].slice.call(document.querySelectorAll('.dot'));
  var fill=document.getElementById('fill');
  var i=0, notesOn=false;
  function draw(){
    for(var k=0;k<S.length;k++){
      S[k].hidden = k!==i;
      var nt=S[k].querySelector('.notes');
      if(nt) nt.hidden = !(notesOn && k===i && nt.textContent.trim().length>0);
      if(D[k]) D[k].className = 'dot' + (k===i?' on':'');
    }
    fill.style.width = (S.length<2?100:(i/(S.length-1))*100) + '%';
  }
  function go(d){ i=Math.max(0,Math.min(S.length-1,i+d)); draw(); }
  function at(k){ i=Math.max(0,Math.min(S.length-1,k)); draw(); }
  document.getElementById('p').addEventListener('click',function(){go(-1);});
  document.getElementById('n').addEventListener('click',function(){go(1);});
  D.forEach(function(b){ b.addEventListener('click',function(){ at(parseInt(b.getAttribute('data-g'),10)||0); }); });
  document.addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowRight'||k==='PageDown'||k===' '||k==='Enter'){ go(1); e.preventDefault(); }
    else if(k==='ArrowLeft'||k==='PageUp'||k==='Backspace'){ go(-1); e.preventDefault(); }
    else if(k==='Home'){ at(0); e.preventDefault(); }
    else if(k==='End'){ at(S.length-1); e.preventDefault(); }
    else if(k==='n'||k==='N'){ notesOn=!notesOn; draw(); }
    else if(k==='f'||k==='F'){
      var d=document.getElementById('deck');
      if(document.fullscreenElement){ document.exitFullscreen&&document.exitFullscreen(); }
      else if(d.requestFullscreen){ d.requestFullscreen(); }
    }
  });
  draw();
})();
</script>
</body></html>`;
}
