# Terra Script

Terra Script is a free, open-source screenwriting app. It formats your screenplay to industry standard as you type, lays your scenes out as index cards and keeps the take log on set.

It runs in the browser or as a Windows desktop app. There is no account and no server: your scripts are saved on your own computer.

The interface is available in English and Indonesian.

## Features

- **Industry-standard pages.** Courier 12pt, correct margins and indents, and real page breaks with (MORE) and (CONT'D). The editor shows pages exactly as they will appear in the PDF.
- **Smart dropdowns.** INT./EXT., locations, times of day and every character you have already written are one keystroke away.
- **Index cards.** Every scene becomes a card with a synopsis and a colour. Drag the cards to restructure the story and the script follows.
- **Take log.** Log slate, take, camera and roll for each scene, and rate every take Good, Maybe or Skip.
- **Storyboard.** Every scene gets a row of panels. Draw each shot with pencil, brush, marker and arrows (stylus pressure supported), or drop in a photo, then add shot size, angle, camera movement, duration and a note. Export the storyboard as a PDF.
- **Pre-production.** A Production tab built on the script: locations, cast and crew (filled in from scene headings and characters), a stripboard schedule with automatic scheduling, a cast-by-day table, call sheets exported as PDF, wardrobe changes with photos, a budget whose cast, crew and location costs follow the schedule, and moodboards.
- **Export.** PDF, [Fountain](https://fountain.io) and plain text, plus reports with statistics and a per-character breakdown.
- **Import.** Open .terra, Fountain and plain-text files, screenplay PDFs (the element of each line is worked out from its indentation) and screenplay JSON in common shapes.
- **Works offline.** Projects are stored locally. A `.terra` file opens the same way on any other device.

## Download

The Windows installer (Windows 10 and 11, about 3 MB) is linked from the "Download for Windows" button on the website and attached to each [GitHub release](https://github.com/nrvaa/terra-script/releases).

The installer is not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**.

Projects made in the browser and in the desktop app are stored separately. To move a project between them, use **Download .terra** in one and **Import file** in the other.

## Development

You need [Node.js](https://nodejs.org) 22 or newer (see `engines` in `package.json`).

```sh
npm install
npm run dev
```

The site runs at `http://localhost:4321`.

| Command | What it does |
| :-- | :-- |
| `npm run dev` | Start the dev server |
| `npm run build` | Build the static site into `dist/` |
| `npm run preview` | Serve the built site locally |
| `npm run desktop:dev` | Run the desktop app with live reload |
| `npm run desktop:build` | Build the Windows installer and copy it to `public/downloads/` |

### Building the desktop app

The desktop app is built with [Tauri 2](https://tauri.app). In addition to Node.js you need:

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Microsoft C++ Build Tools ("Desktop development with C++")
- WebView2, which is already included in Windows 10 and 11

`npm run desktop:build` writes the installer to `src-tauri/target/release/bundle/nsis/` and copies it to `public/downloads/TerraScript-Setup.exe`, where the website's download button serves it from. The first build takes several minutes. Later builds are faster.

## Project structure

```text
src/
  pages/        index (landing page), projects, write (the editor)
  components/   shared Astro components: logo, loader, theme switch
  scripts/      the app itself, in TypeScript
    editor.ts     screenplay editing and element types
    page-view.ts  the page view, broken where the PDF breaks
    cards.ts      index card view
    takes.ts      take log
    pdf.ts        pagination rules and PDF export
    fountain.ts   Fountain import and export
    i18n.ts       English and Indonesian strings
    save-file.ts  downloads in the browser, Save dialog in the desktop app
  styles/       global and feature CSS (Tailwind CSS 4)
src-tauri/      desktop app configuration (Tauri)
scripts/        build helpers
public/         static files, including the installer download
```

## Translations

All interface text lives in `src/scripts/i18n.ts`, with one dictionary per language. To add a language, copy the `en` dictionary, translate the values, add the language code to `Lang` and `LANGS` in the same file, and add it to the language menus in `src/pages/index.astro` and `src/pages/projects.astro`.

## Contributing

Bug reports and pull requests are welcome. For larger changes, please open an issue first to discuss what you would like to change.

When you submit a pull request:

- Keep changes focused on one thing.
- Run `npm run build` and make sure it finishes without errors.
- If you add interface text, add it to both the English and Indonesian dictionaries.

## Credits

Built with [Astro](https://astro.build), [Tailwind CSS](https://tailwindcss.com) and [Tauri](https://tauri.app).

Several UI elements are adapted from [Uiverse.io](https://uiverse.io) (MIT licensed), by Smit-Prajapati, mobinkakei, Galahhad, JustCode14 and TamaniPhiri.

The fonts Courier Prime, Inter and Space Grotesk are licensed under the SIL Open Font License and bundled through [Fontsource](https://fontsource.org).

## License

[MIT](LICENSE)
