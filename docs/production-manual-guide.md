# Production Manual Writing Guide

## How to write a production manual that maximizes what My Broadcast can auto-generate

When you upload a production manual to My Broadcast, AI analyzes it and creates **layouts** (OBS scene + graphic combinations), **graphics** (overlay elements), and **formats** (script templates). The better structured your manual, the more accurate and complete the auto-generation.

---

## Document Structure

Organize your manual with these sections in this order. Each section maps to specific features in the app.

### 1. SHOW OVERVIEW

**What the AI extracts:** Show name, schedule, duration, tone, audience context.

**Include:**
- Show name and tagline
- Broadcast schedule (days, time, timezone)
- Episode duration range
- Number and type of source inputs (cameras, screen captures)
- Brief description of the show's identity and tone
- Target audience

**Example:**
> "The Morning Signal" is a daily 20-minute live broadcast covering AI industry news, airing Monday-Friday at 8:00 AM ET. Two source inputs: one face camera, one screen capture. Tone is professional but conversational, aimed at tech professionals and AI enthusiasts.

---

### 2. SCENE SYSTEM

**What the AI extracts:** OBS scenes → becomes **Layouts** in the app.

**Critical:** Use a consistent naming convention. Each scene must have:

| Field | Description | Example |
|-------|-------------|---------|
| **Scene Name** | Short, unique identifier | "The Interview" |
| **Layout Description** | How inputs are arranged | "Face camera 70% left, guest video 30% right" |
| **Composition Details** | What's visible, what's hidden | "Host visible, guest visible, no overlays" |
| **When to Use** | Content situations that trigger this scene | "During guest conversations, Q&A segments" |

**Format as a table for best results:**

```
Scene Name | Layout | Composition | When to Use
-----------|--------|-------------|------------
Full Face  | Face camera fills frame | Host only, no screen | Direct-to-camera commentary
Screen Share | Screen 80%, face pip 20% | Screen primary, host secondary | Showing articles, data, demos
Side by Side | 50/50 split | Both sources equal | Comparisons, debates
Title Card | Full-frame graphic | No camera inputs | Transitions, intro/outro
```

**Tips:**
- Name scenes descriptively (not "Scene 1", "Scene 2")
- Describe the spatial arrangement specifically (percentages, positions)
- Mention which overlays/graphics typically appear with each scene
- Note if a scene is exclusive to certain days or segments

---

### 3. GRAPHICS & OVERLAYS

**What the AI extracts:** Each graphic → becomes a **Graphic** card in the Rundown.

**For each graphic element, define:**

| Field | Description |
|-------|-------------|
| **Name** | Unique identifier (e.g., "host_lower_third") |
| **Type** | lower_third, message, ticker, agenda, image, timer, score |
| **Visual Description** | Colors, position, size, transparency |
| **Content Fields** | What text/data it displays and what changes per episode |
| **Behavior** | When it appears, how long, how it's triggered |

**Supported graphic types and their content structure:**

```
LOWER THIRD
- Title: [host name or guest name]
- Subtitle: [role/title or topic]
- Position: bottom-left
- Duration: 8-10 seconds

MESSAGE / BANNER
- Text: [headline or alert text]
- Detail: [supporting information]
- Position: top or center

TICKER
- Items: [list of scrolling text items]
- Speed: pixels per second
- Position: bottom of frame

AGENDA
- Title: [optional heading, e.g. "AGENDA" or "TODAY'S SHOW"]
- Items: [list, one per line; prefix a line with `-` to make it an indented sub-item]
- Position: left side panel

IMAGE
- URL/file reference
- Sizing: contain or cover
- Position: where on screen

TIMER
- Mode: countdown, count-up, or clock
- Duration: in seconds
- Format: HH:mm:ss or mm:ss
- Label: descriptive name

SCORE
- Team 1: name, color
- Team 2: name, color
- Scoring method
```

**What makes a graphic description work well for auto-generation:**
- Explicitly state the graphic type from the supported list above
- Describe what content changes per episode vs. what stays fixed
- Use placeholder notation for variable content: `[Headline]`, `[Guest Name]`
- Reference which scenes the graphic appears with
- Specify timing (when it appears, how long it stays)

---

### 4. SEGMENT STRUCTURE

**What the AI extracts:** Segments → becomes **Formats** (script templates) with steps.

**For each recurring segment type, define:**

| Field | Why It Matters |
|-------|----------------|
| **Segment Name** | Becomes the format name |
| **Duration** | Helps AI pace the script |
| **Structure** | Step-by-step flow with production actions |
| **Scene/Layout Usage** | Which scenes are used when |
| **Graphics Usage** | Which graphics appear/disappear and when |
| **What Changes Per Episode** | Becomes episode requirements |
| **What Stays Fixed** | Becomes locked steps |

**Best format: a timeline/runsheet table:**

```
Time    | Segment        | Host Action                    | Production Action
--------|----------------|--------------------------------|------------------
0:00    | Cold Open      | Delivers hook while making     | [Full Face scene]
        |                | coffee                         | No overlays
1:30    | Title Hit      | Pauses, music drops            | [Title Card scene]
        |                |                                | Play intro beat (15 sec)
1:50    | Intro          | Greets audience, previews      | [Full Face scene]
        |                | today's content                | Show lower_third (10 sec)
2:00    | Story 1        | Discusses first news story     | [Screen Share scene]
        |                |                                | Show story_card_1
        |                |                                | Update headline to [Story 1 Headline]
```

**Key details for format generation:**
- Mark which steps are structural (same every episode) → these become **locked steps**
- Mark which steps have variable content → these need **episode requirements**
- Note the exact production actions: show/hide graphics, switch scenes, play audio
- Use `[Placeholder]` notation for anything that changes per episode

---

### 5. EPISODE VARIATIONS

**What the AI extracts:** Day-specific or type-specific differences → may generate multiple formats.

**If your show varies by day or episode type, create a table:**

```
Day/Type    | Emphasis           | Unique Requirements        | Unique Graphics
------------|--------------------|-----------------------------|----------------
Monday      | News roundup       | 4-5 story cards             | story_card overlay
Tuesday     | Deep analysis      | Data overlay panels         | data_panel overlay
Wednesday   | Live demo          | Demo prerequisites verified | (standard)
Friday      | Weekly recap       | Tracker graphic updated     | singularity_tracker
```

**Or for non-daily shows:**

```
Episode Type | Format Name     | Unique Elements
-------------|-----------------|----------------
Interview    | Guest Interview | Guest lower_third, split screen
Solo Deep    | Deep Dive       | Data overlays, full screen share
Panel        | Panel Discussion| Multiple lower_thirds, grid layout
```

---

### 6. AUDIO ASSETS

**What the AI extracts:** Audio cues → becomes actions (play/trigger) in script steps.

**List each audio asset:**

```
Asset Name        | Duration | When Used                    | Technical Notes
------------------|----------|------------------------------|----------------
Intro Beat        | 15 sec   | Title card after cold open   | Signature sound
Transition Sting  | 3 sec    | Between major segments       | 3-4 variations
Closing Beat      | 90 sec   | Final performance segment    | Host performs over this
Alert Sting       | 3 sec    | Breaking news activation     | Urgent tone
Pre-Show Ambient  | 10 min   | Countdown before show starts | Loop, low energy
```

---

### 7. TREATMENTS & SPECIAL MODES

**What the AI extracts:** Visual treatments → becomes combinations of graphics and layout switches.

**For each treatment/mode:**

```
Treatment Name | Visual Description                          | Trigger Condition
---------------|---------------------------------------------|------------------
Breaking Alert | Red banner top, amber ticker bottom         | Major unplanned news
Letterbox      | Black bars top/bottom for cinematic feel    | Dramatic reveals
Performance    | Tight face, dark background, audio viz bars | Musical segments
End Card       | Full-frame branded close with links         | Final 15 seconds
```

---

### 8. QUALITY STANDARDS (Optional but Recommended)

Helps the AI understand constraints when generating scripts:

- Resolution requirements
- Lighting setup notes
- Audio level standards
- Visual brand rules (color palette, fonts, graphic style)
- Content rules (what must always happen, what must never happen)
- Timing rules (start time, segment durations, pacing guidelines)

---

## Formatting Rules for Best Auto-Generation

### DO:
- **Use tables** wherever possible — they parse much more reliably than paragraphs
- **Use consistent naming** — if you call it "Scene 2" in one place, don't call it "Screen Share Layout" in another without linking them
- **Use `[Placeholders]`** in brackets for content that changes per episode
- **State graphic types explicitly** using the supported types: lower_third, message, ticker, agenda, image, timer, score
- **Number your scenes** and give them names (Scene 1: "The Brew", Scene 2: "The Work")
- **Describe production actions as verbs** — "Show lower_third", "Hide story_card", "Switch to Scene 2", "Play intro beat"
- **Separate fixed vs. variable** — clearly distinguish what stays the same vs. what changes per episode
- **Include a minute-by-minute runsheet** for at least one standard episode
- **List all graphic elements** individually with their exact content fields

### DON'T:
- Don't write the manual as a creative brief — be specific and technical
- Don't use vague descriptions like "make it look professional" — describe exactly what appears on screen
- Don't embed production actions inside paragraphs — use tables or bullet lists
- Don't assume the reader knows your show — define every term, scene, and element
- Don't mix scene descriptions with overlay descriptions — keep them in separate sections
- Don't skip the timing — every segment needs a duration or time marker

---

## Template: Minimal Production Manual

For a quick setup, your manual needs at minimum these sections:

```
1. SHOW OVERVIEW
   - Name, schedule, duration, inputs, tone

2. SCENES (table)
   - Scene Name | Layout | When to Use

3. GRAPHICS (table)
   - Name | Type | Content | When Shown

4. EPISODE FLOW (timeline table)
   - Time | Segment | Host Action | Production Action

5. WHAT CHANGES PER EPISODE (list)
   - Variable 1: [description]
   - Variable 2: [description]
```

This minimal structure is enough to auto-generate layouts, graphics, and one format. Add more sections (audio, treatments, day variations, quality standards) for richer output.

---

## Template: Comprehensive Production Manual

For maximum auto-generation power, include all 8 sections above. Your Singularity Show manual is a strong reference — it produced 11+ graphics and 9+ layouts because it included:
- 6 named scenes with detailed composition descriptions
- 5 distinct overlay types with content field specifications
- A minute-by-minute production runsheet
- Day-by-day variation table
- 4 special episode types
- 6 audio assets
- 5 visual treatments
- Explicit quality standards

The more structured detail you provide, the more the system can auto-generate — fewer things to set up manually afterward.
