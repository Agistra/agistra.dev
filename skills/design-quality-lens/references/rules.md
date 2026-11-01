# Design Quality Rules

18 rules. Required rules are objectively checkable. Recommended rules are tells of generated output; a deliberate, recorded choice can waive them. "Token" below means a named CSS custom property, theme key or equivalent declared once by the project.

Ids are stable. Cite them in findings and in waivers.

## Required

### DQ-01 Colours come from tokens
- Statement: every colour in styles and markup resolves to a declared token. No loose hex, rgb or hsl values outside the token declarations.
- Check: grep styles and markup for `#[0-9a-fA-F]{3,8}\b`, `rgba?\(`, `hsla?\(`; discard hits inside the token declaration block.
- Evidence: `src/components/Card.astro:42  border: 1px solid #3a3a4a` while no token holds that value.

### DQ-02 Fonts come from tokens
- Statement: font families are set through declared font tokens. No ad hoc `font-family` lists in components, and no more families loaded than the tokens name.
- Check: grep `font-family` outside the token declarations; list font files or `@font-face`/link requests and compare to the token set.
- Evidence: `Hero.astro:18  font-family: Georgia, serif` against tokens that declare only a sans and a mono.

### DQ-03 No `transition: all`, no animated layout properties
- Statement: transitions and animations name the properties they change, and those properties do not trigger layout.
- Check: grep `transition:\s*all`, `transition-property:\s*all`; grep `transition` and `@keyframes` bodies for `width|height|top|left|right|bottom|margin|padding`.
- Evidence: `global.css:210  transition: all 0.3s`; a keyframes block `slide` animating `left`.

### DQ-04 Visible keyboard focus on every interactive element
- Statement: links, buttons, form controls, tabs and custom controls show a visible focus indicator when focused by keyboard.
- Check: static: grep for `outline:\s*(none|0)` and `:focus` rules with no `:focus-visible` replacement. Rendered: tab through the page and read computed `outline` and `box-shadow` on each focused element.
- Evidence: `global.css:55  a:focus { outline: none }` with no replacement style.

### DQ-05 Reduced-motion fallback
- Statement: every animation or transition that moves, scales or fades large areas is disabled or shortened under `prefers-reduced-motion: reduce`.
- Check: grep `@keyframes`, `animation`, `transition` and confirm a `@media (prefers-reduced-motion: reduce)` block neutralises them; or emulate the preference and read computed `animation-name` and `transition-duration`.
- Evidence: 3 keyframe animations, 0 `prefers-reduced-motion` blocks in the stylesheet.

### DQ-06 No horizontal scroll at the four named widths
- Statement: at 390, 768, 1280 and 1920 px viewport width, the page does not scroll sideways.
- Check: rendered: at each width compare `document.documentElement.scrollWidth` with `clientWidth`. Static fallback: flag fixed widths above 390px, `100vw` on full-width blocks and unwrapped long strings, and report the rule as "not rendered".
- Evidence: at 390 px, scrollWidth 468 vs clientWidth 390; a code block with `white-space: pre` and no overflow rule is 468 px wide.

### DQ-07 Content readable without scripting
- Statement: the page's main text, headings and links exist in the delivered HTML. Script may enhance but must not be required to see core content or reach navigation.
- Check: read the built or served HTML without running script and search for the headline and primary navigation text; grep for client-only islands that hide content until hydration.
- Evidence: fetched HTML of `/` contains no `<h1>`; the headline is created by a client-only component.

### DQ-08 No invented metrics, testimonials or logos
- Statement: numbers, quotes, customer names and logos shown as proof are real and sourced. Placeholder or made-up proof is a defect.
- Check: list every statistic, quote, name and logo on the page; for each, find a source in the repo (data file, content entry, commit note) or a supplied brief. No source means a finding.
- Evidence: "Trusted by 10,000 teams" in `TrustProof.astro:12` with no data source and no brief naming that figure.

### DQ-09 Text contrast meets the stated bar
- Statement: body and UI text meets the project's named contrast ratio; where none is named, 4.5:1 for normal text and 3:1 for large text.
- Check: rendered: compute foreground and background of each distinct text style and calculate the ratio. Static: resolve token values and calculate for token pairs used for text.
- Evidence: `--text-muted #7a7f8c` on `--bg #14161c` = 4.1:1, used for 14 px body copy.

### DQ-10 Meaningful images carry alt text
- Statement: every content image has a text alternative; purely decorative images have an empty `alt`.
- Check: grep `<img` and image components for a missing `alt` attribute; list images with empty `alt` and confirm each is decorative.
- Evidence: `Hero.astro:30  <img src="/dash.png">` with no `alt`.

## Recommended

### DQ-11 Small tracked-caps eyebrow labels
- Statement: avoid a small, uppercase, wide-letter-spaced label above headings as a repeated pattern.
- Check: grep `text-transform:\s*uppercase` alongside `letter-spacing` of 0.08em or more and `font-size` below 14px; count the headings they precede.
- Evidence: `.eyebrow` used above 6 of 7 section headings (`font-size: 12px; letter-spacing: 0.14em; uppercase`).

### DQ-12 Purple-to-blue gradients
- Statement: avoid the stock gradient that runs from purple or violet to blue, as a fill, text clip or glow.
- Check: grep `gradient\(` and resolve each stop's hue; flag stops between about 250 and 290 degrees paired with stops between about 200 and 250 degrees.
- Evidence: `background: linear-gradient(135deg, #7c3aed, #3b82f6)` on the hero heading.

### DQ-13 Cards inside cards
- Statement: avoid a bordered or shadowed container nested inside another bordered or shadowed container.
- Check: rendered: for each element with a border or box-shadow, test whether an ancestor in the same section also has one. Static: read component trees for a card component rendered inside a card component.
- Evidence: `Roster.astro` renders `.card` inside `.panel`, both with 1px borders and radius.

### DQ-14 Emoji used as icons
- Statement: avoid emoji standing in for icons in headings, lists, buttons or feature grids.
- Check: Unicode-aware grep of markup and content for emoji ranges, for example `[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]` with `rg` or `grep -P`.
- Evidence: `Features.astro:20  <span class="icon">🚀</span>` as a feature icon.

### DQ-15 Drawn fake browser or OS windows
- Statement: avoid decorative mock windows (three-dot title bars, fake address bars, faux terminals) built from markup instead of real screenshots or real code.
- Check: grep for traffic-light dot patterns (three small round siblings filled red, yellow and green), class names like `window`, `titlebar`, `browser-frame`, and fake URL bars.
- Evidence: `.terminal-dots span:nth-child(1..3)` filled `#ff5f56`, `#ffbd2e`, `#27c93f`.

### DQ-16 Middle-dot meta strings
- Statement: avoid strings of short facts joined by middle dots or bullets as a meta line (for example price, licence, read time).
- Check: grep markup and content for ` · ` or ` • ` between two or more short fragments in one text node.
- Evidence: `<p class="meta">Free · Open source · MIT</p>` in the hero.

### DQ-17 Text-heavy screens
- Statement: avoid first screens and landing sections that hold more reading than a visitor takes in at a glance.
- Check: rendered: at 1280x800, count words of visible text in the first viewport; more than about 150 is a finding. Static: count words per section component and flag sections above about 200.
- Evidence: first viewport at 1280x800 holds 212 visible words across banner, headline, paragraph and three cards.

### DQ-18 Hero headline and main action visible at 1280x800
- Statement: the hero headline and the primary call to action are both visible without scrolling at 1280x800.
- Check: rendered: at 1280x800, locate the `h1` and the primary action; confirm both bounding boxes sit fully inside the 800 px viewport height. Static only: report "not rendered" and list the stacked elements above them.
- Evidence: `h1` bottom at 392 px, primary button top at 861 px, below the fold.
