# Product

## Register

brand

The repo's runtime product is a terminal radio (a TUI); the only *designed web
surface* is the homepage (`docs/index.html`). Design work on that surface runs
in the brand register.

## Users

Developers and curious tinkerers who find the repo through GitHub or a link.
They read fast, distrust marketing, and can judge a project by whether the
demo looks real. Many read Chinese; the page is bilingual (EN default, Chinese
toggle) and the radio speaks the listener's own language on air — their
machine's locale by default, English where it says nothing.

## Product Purpose

murmur exists as a counter-position: most AI projects today are marketing,
AI short-form drama, or productivity tooling. murmur is none of these — it is
**AI that sits closer to the person**. A local-first companion radio with an
agent for a brain (Claude today; the brain is a swappable seam): always on the
air, it finds its own topics, plays music,
and answers in a voice that sounds human when you type to it. The
homepage succeeds when a visitor *feels* that closeness within one screen and
can run it in two commands.

## Brand Personality

Near, unhurried, honest. The warmth of a late-night radio host carried on a
precise, terminal-native structure — never SaaS-slick, never hype. The page
speaks the way the host does: plainly, in complete sentences, with a little
tenderness and zero superlatives.

## Anti-references

- AI-product marketing landing pages (gradient heroes, metric walls, badge
  rows, "supercharge your workflow").
- Productivity-SaaS grammar: pricing tables, logos-of-trust strips, identical
  feature card grids.
- Hype aesthetics of the AI short-drama / content-farm world: loud, fast, disposable.

Structural reference (positive): herdr.dev — JetBrains Mono display headings,
hairline-ruled split layouts, dark terminal panels inset in the page, a real
session as the hero demo.

## Design Principles

1. **Show the radio, don't pitch it.** The hero demonstrates a real on-air
   moment (talk, music, a typed reply, the host reacting) instead of claims.
2. **Warmth rides on precision.** The mascot, the host's Chinese lines, and
   the copy carry the warmth; the layout stays ruled, mono-set, exact.
3. **The page speaks like the host.** Copy in the host's voice — first person
   where natural, concrete, no feature-brochure tone.
4. **Honest status.** Open-source, non-commercial, still being built by ear —
   said plainly, never dressed up.
5. **Bilingual is first-class.** EN/zh both fully written, never
   machine-flat; the toggle is part of the product's identity.

## Accessibility & Inclusion

WCAG AA: body text ≥4.5:1, large text ≥3:1, visible focus states, skip link,
full `prefers-reduced-motion` alternatives, semantic landmarks. The terminal
demo must remain readable text (no image-of-text).
