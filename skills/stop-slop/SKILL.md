---
name: stop-slop
description: "Use when: reviewing or producing any external-facing prose — ADRs, proposals, GitHub comments, Telegram messages, cover letters, client drafts, or planner-mode wording. Removes AI-tell patterns and raises writing quality before output leaves the team."
argument-hint: "Prose to review, draft to clean, or writing scored below 35/50"
---

# Stop Slop

Adapted from [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) (MIT). Removes predictable AI writing patterns from any external-facing output. Load this skill before finalising any prose that will be read by a human outside the team.

## When to Apply

Always-on for Architect, Router, and CAO when producing or reviewing:

- ADR context and consequences sections
- Planner-mode client drafts and proposal wording
- GitHub issue and PR comments intended for external audiences
- Telegram or relay messages to the remote team
- Cover letters, recruiter replies, or stakeholder communications
- Blog posts, articles, and marketing or campaign copy

Do not apply to internal memory files, ticket descriptions, or code comments — those optimise for precision, not prose.

---

## Eight Rules

**1. Eliminate filler.**
Remove throat-clearing openers ("In today's fast-paced...", "It's important to note that..."), intensifying adverbs ("very", "extremely", "incredibly"), and meta-commentary ("This section explores..."). Start with the claim.

**2. Break formulas.**
Avoid binary contrasts ("not just X, but Y"), rhetorical questions as transitions, and three-part lists that exist for rhythm rather than content. If a structure feels satisfying to write, it probably reads as a template.

**3. Use active voice.**
Human subjects performing actions. Passive constructions ("It was decided that...", "Steps were taken to...") hide agency. Name who does what.

**4. Be specific.**
Name the thing. "Azure Function App processing webhook events" beats "cloud-based solution". "96% test coverage enforced via PR gate" beats "strong quality culture". Vague language signals the writer does not know the detail.

**5. Engage directly.**
Write to a person, not at a concept. Replace distant narration ("One might consider...") with direct address or direct claim.

**6. Vary sentence rhythm.**
Achieve burstiness — deliberate sentence length variance that makes text feel written rather than generated. Uniform sentence length is a structural AI tell regardless of word choice. Mix short declarative sentences with longer ones. Do not end every paragraph on a long clause. Read aloud — if it sounds like a slide deck, rewrite it.

**7. Trust the audience.**
Remove softeners that exist to manage your anxiety rather than the reader's understanding: "It is worth noting that...", "One potential consideration might be...", "While there are many factors...". State the thing.

**8. Cut quotable lines.**
Rewrite any sentence that feels like it belongs on a conference slide or LinkedIn post. Aphorisms in prose are a tell. If it feels clever, it is probably slop.

---

## Banned Phrase Categories

**Throat-clearing openers:**
- "In today's world..."
- "It's important to note..."
- "As we all know..."
- "At the end of the day..."
- "It goes without saying..."

**False agency and passive constructions:**
- "Steps were taken to..."
- "It was decided that..."
- "Consideration should be given to..."
- "It has been observed that..."

**Vague declaratives:**
- "This is a game-changer."
- "The results speak for themselves."
- "We are committed to excellence."
- "Leveraging best-in-class solutions..."

**Structural clichés:**
- "Not just X, but Y." (binary contrast)
- "First... Second... Finally..." (slide-deck list)
- "The question is not whether X, but when." (rhetorical formula)
- "In conclusion..." / "To summarise..."

**Unnecessary softeners:**
- "It is worth noting that..."
- "One might argue..."
- "While there are many perspectives..."
- "It could be said that..."

**Emerging 2026 AI tells:**
- Hedging stacking — three or more hedging words in one sentence ("it might arguably be worth considering")
- Markdown bleeding — formatting structure leaking into prose (a sentence that reads like a heading; a paragraph that reads like a list item)
- Paragraph-reshuffling immunity — all paragraphs of equal length and rhetorical weight; rearranging them would not change the piece
- Significance inflation — framing routine things as pivotal, transformative, or game-changing

---

## Pre-Submission Checklist

Before sending any external prose, scan for:

- [ ] Em dashes used for stylistic effect — remove or rewrite
- [ ] Adverbs ending in -ly modifying a verb — cut or strengthen the verb
- [ ] Sentences beginning with "Wh-" words as transitions — rewrite
- [ ] Passive voice constructions — rewrite with named subject
- [ ] Any sentence that reads like a pull-quote — cut
- [ ] Any sentence with three or more hedging words — rewrite to a direct claim
- [ ] Any paragraph that could be moved elsewhere without losing meaning — cut or rewrite to anchor it

---

## Scoring Rubric

Score the prose on five dimensions (0–10 each, 50 max). Revise if total < 35.

| Dimension | 0–4 | 5–7 | 8–10 |
|-----------|-----|-----|------|
| **Directness** | Buried claims, hedged throughout | Main point findable but delayed | Claim in first sentence, no hedging |
| **Rhythm** | Uniform sentence length, monotone | Some variation | Deliberate mix of short and long |
| **Trust** | Constant softening, qualifies everything | Occasional hedging | Trusts the reader, states directly |
| **Authenticity** | Multiple AI-tell phrases | One or two tells | No recognisable AI patterns |
| **Density** | Padded, repetitive, filler present | Reasonable but some waste | Every sentence earns its place |

**Score interpretation:**
- 45–50: Ship it
- 35–44: Minor polish, acceptable
- 25–34: Rewrite needed before sending
- < 25: Start over

---

## Exit Criteria

Stop Slop is applied when:
- the prose passes the pre-submission checklist, or
- the score is ≥ 35 and no banned phrases remain

Do not loop indefinitely. Two passes maximum. If the content cannot reach 35 after two rewrites, surface it to the team lead rather than polishing further.
