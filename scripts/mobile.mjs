/**
 * Ads on a phone: a MEASURED report of what does not fit, per page.
 *   node scripts/mobile.mjs [baseUrl] [outDir] [--width=390] [--desktop] [--coin=<MINT>]
 * Measures sideways overflow, tap targets under 32px, fields under 16px (iOS zooms into them), console errors and failed
 * requests. ⚠ A fresh page per route: a fullPage screenshot on a mobile context drops touch emulation for later routes.
 * Needs Playwright (PLAYWRIGHT_FROM=<path to playwright/index.js> when it is not installed here).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

// Playwright is not a dependency of the site: install it anywhere and point PLAYWRIGHT_FROM at its index.js.
const PW = process.env.PLAYWRIGHT_FROM ?? 'playwright';
const { chromium } = createRequire(import.meta.url)(PW);
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const base = (positional[0] ?? 'https://pumpfunads.com').replace(/\/+$/, '');
const out = positional[1] ?? '/tmp/ads-mobile';
const WIDTH = Number(flags.find((f) => f.startsWith('--width='))?.split('=')[1] ?? 390);
const DESKTOP = flags.includes('--desktop');
const COIN = flags.find((f) => f.startsWith('--coin='))?.split('=')[1];
mkdirSync(out, { recursive: true });
const PAGES = [['home', '/'], ['feed', '/feed'], ['launch', '/launch'], ['explore', '/explore'], ['mine', '/mine'], ['how', '/how'], ['notfound', '/nope'], ...(COIN ? [['coin', `/t/${COIN}`]] : [])];

/** Right edge past the viewport, or intrinsically wider than it. */
const MEASURE = (touch) => {
  const vw = window.innerWidth
  const offenders = []
  const clipped = []
  const smallTargets = []
  const zoomInputs = []

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (el.closest('[aria-hidden="true"]') && style.pointerEvents === 'none') continue // decorative (a glow), clipped by its parent

    // ⚠ An element inside its own horizontal scroller is not a page-level overflow.
    let scroller = null
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p)
      if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { scroller = p; break }
    }

    const label = () => {
      const cls = typeof el.className === 'string' ? el.className : ''
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''}`
    }

    if (scroller) {
      // Content only reachable by swiping sideways inside a scroller.
      const sr = scroller.getBoundingClientRect()
      const over = Math.round(r.right - sr.right)
      if (over > 1 && el.textContent && el.textContent.trim()) {
        clipped.push({ el: label(), over, inside: scroller.className || scroller.tagName })
      }
      continue
    }

    if (style.position === 'fixed') continue

    const over = Math.max(r.right - vw, r.width - vw)
    if (over > 1) offenders.push({ el: label(), w: Math.round(r.width), over: Math.round(over) })

    /*
      ⛔ Tap targets. 44px is Apple's floor and roughly a fingertip. Only things that are actually
      pressable, and only when they carry a hit area of their own — an inline link inside a
      paragraph is text, not a control.
    */
    const tag = el.tagName.toLowerCase()
    // iOS Safari zooms the page into any focused field whose text is under 16px.
    if (touch && ['input', 'textarea', 'select'].includes(tag) && el.type !== 'file' && el.type !== 'checkbox' && el.type !== 'radio' && parseFloat(style.fontSize) < 16) zoomInputs.push({ el: label(), size: style.fontSize })
    /*
      ⚠ Something nobody can tap is not a tap target. A hidden file input clicked by a styled button
      is the standard pattern — it is deliberately 1x1 and `pointer-events: none`, and reporting it
      as too small is a fault the report can never be right about.
      ⛔ Judged on `pointer-events` and opacity, not on a class name: the next such element will
      have a different one.
    */
    const untappable = style.pointerEvents === 'none' || Number(style.opacity) === 0
    const pressable =
      !untappable && (tag === 'button' || (tag === 'a' && el.getAttribute('href')) || tag === 'input')
    // ⚠ A tap-target floor is a rule about FINGERS. Applying it to a mouse run reports every
    // compact control on the desktop layout as a fault, which is how a report stops being read.
    if (touch && pressable && r.height > 0) {
      /*
        ⚠⚠ Measures the HIT AREA, not the painted box. A control can be grown for a fingertip with
        an absolutely positioned `::after` that paints nothing and moves no layout — the common fix
        on a page this dense — and `getBoundingClientRect` cannot see it. Reporting the painted box
        would flag every control that has ALREADY been fixed, and a report that cries wolf is one
        nobody reads.
      */
      let hitW = r.width
      let hitH = r.height
      const after = getComputedStyle(el, '::after')
      if (after && after.content !== 'none' && after.position === 'absolute') {
        const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0)
        // A negative inset computes as a negative length, so growing the box means subtracting it.
        hitW += -px(after.left) + -px(after.right)
        hitH += -px(after.top) + -px(after.bottom)
      }
      if (hitH < 32 || hitW < 32) {
        const inParagraph = el.closest('p') !== null
        if (!inParagraph) {
          smallTargets.push({
            el: label(),
            w: Math.round(r.width),
            h: Math.round(r.height),
            hit: `${Math.round(hitW)}x${Math.round(hitH)}`,
          })
        }
      }
    }
  }

  offenders.sort((a, b) => b.over - a.over)
  return {
    docScroll: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    offenders: offenders.slice(0, 12),
    clipped: clipped.slice(0, 8),
    smallTargets: smallTargets.slice(0, 8),
    zoomInputs: zoomInputs.slice(0, 8),
  }
}

const browser = await chromium.launch();
const context = await browser.newContext(DESKTOP ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
let problems = 0;
console.log(`==> ${base} at ${DESKTOP ? '1440x900 (desktop)' : `${WIDTH}x844`}\n`);
for (const [name, path] of PAGES) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message).slice(0, 160)}`));
  page.on('response', (r) => { if (r.status() >= 400 && !(name === 'notfound' && r.status() === 404)) errors.push(`${r.status()} ${r.url().replace(base, '').slice(0, 120)}`); });
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' }).catch((e) => errors.push(`goto: ${e.message.slice(0, 120)}`));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(MEASURE, !DESKTOP);
  const blank = await page.evaluate(() => document.body.innerText.trim().length < 20);
  await page.screenshot({ path: `${out}/${DESKTOP ? 'desktop-' : ''}${name}.png`, fullPage: true });
  const bad = blank || errors.length || r.docScroll > 1 || r.offenders.length || r.clipped.length || r.smallTargets.length || r.zoomInputs.length;
  if (bad) problems += 1;
  console.log(`${bad ? '✗' : '✓'} ${name.padEnd(9)} sideways ${r.docScroll}px${blank ? '  BLANK PAGE' : ''}`);
  for (const e of errors) console.log(`      error     ${e}`);
  for (const o of r.offenders) console.log(`      overflow  ${o.el} — ${o.w}px wide, ${o.over}px past the edge`);
  for (const c of r.clipped) console.log(`      clipped   ${c.el} — ${c.over}px past its scroller`);
  for (const t of r.smallTargets) console.log(`      tap       ${t.el} — drawn ${t.w}x${t.h}px, hit area ${t.hit}`);
  for (const z of r.zoomInputs) console.log(`      ios-zoom  ${z.el} — font ${z.size}`);
  await page.close();
}
await browser.close();
console.log(`\n${problems === 0 ? 'no problems measured' : `${problems} page(s) with problems`}; screenshots in ${out}`);
process.exit(problems === 0 ? 0 : 1);
