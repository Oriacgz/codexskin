# codexskin

An unofficial theme manager for the Codex desktop app. Import themes, create
backgrounds from your own images, and switch between saved looks.

codexskin applies styles at runtime through a local debugging connection. It
does not patch the official application's files. It uses a dedicated Codex
profile, so you may need to sign in again in that profile.

## Features

- Installed themes section with previews, current-theme indicator, and quick switching.
- Import local `.zip` and `.codextheme` themes in supported simple and DreamSkin manifest formats.
- Create a theme using a PNG, JPEG, or WebP image, up to 10 MiB. Image filenames provide an editable default name; progress and errors appear inside the editor.
- Choose app-wide primary (normally white) and secondary (normally grey) text colors per theme.
- Subtle dark surfaces behind automation suggestion cards improve readability.
- Customize image brightness (20–180%), accent color, and sidebar/composer colors.
- Set independent sidebar and composer opacity (0–100%), with translucent and opaque presets.
- Adjust darkness independently for the sidebar, your messages, AI replies, and thinking/activity text.
- Collapsed sidebar hover panels keep their tint and blur, with at least 32% opacity for readability.
- Apply shared theme surfaces to Projects, Library, Plugins, Settings, and the Images composer.
- Adjustable page opacity for Settings, Profile, Projects, and the native Upgrade page.
- Adjustable dialog/project chooser opacity, including Create project dialogs.
- On-demand compatibility checks for theme layers and current-page styling targets.
- Fixed live preview beside independently scrolling editor controls, with automatic Chat / Pages preview switching, per-theme settings, and reset to package appearance.
- Restore the official look and optionally keep themes applied across launches.
- Windows tray, optional launch at login, and a desktop executable without a console window.
- Official codexskin logo in the control window, taskbar, tray notifications, and executable. Icon assets are embedded for standalone use.
- Restore the official ChatGPT taskbar icon and package identity while the tray is running.

## Start on Windows

Install the official Codex desktop app first. Open `codexskin-app.exe` from the
release folder. Keep the accompanying license files with the application.
No separate Node.js installation is needed for the packaged executable.

1. Choose **Import theme** for a supported `.zip` or `.codextheme`, drag the package into the window, or choose **Create theme** for your own image. The **Browse Codex Themes** link opens [the theme directory](https://codexthemes.app/themes); download a package there and import it locally.
2. Use **Edit** to change brightness, accent, surface colors, opacity, and readability settings.
3. Open **Installed themes**, choose a theme, and click **Switch theme**.
4. Use **Restore official look** to remove the skin.

The first imported theme attempts to apply automatically. Creating a theme
adds it to the collection; apply it when ready. Changes to the active theme
apply immediately when Codex is connected. Offline changes are saved for the
next apply/watch cycle. Imported package files remain unchanged by edits.

Codex must run with the theme profile and local debugging port for changes to
apply. If a normal Codex instance is running, the UI asks before a required
restart unless you have already enabled automatic restart. Restarting closes
and reopens Codex; finish any work that would be interrupted first.

Windows Search launches remain in their standard profile; the desktop watcher
does not automatically close or replace them. Use **Launch skinned Codex** to
switch explicitly.

Closing Codex leaves it closed; the desktop watcher does not relaunch a closed
app. Use Launch skinned Codex to open it again. The CLI watch command retains
its explicit relaunch behavior unless run with --no-launch.

Closing the control window leaves codexskin in the tray. Select **Quit codexskin**
to exit completely. To update, quit the old version before opening the new one.

Use **Check compatibility** to inspect each connected Codex window. Warnings
identify missing theme layers or current-page targets. Hidden controls may also
cause a warning; this check does not certify every page or Codex version.

## Customize a theme

Open **Installed themes → Edit**. Settings are saved separately for each theme,
including imported themes; **Reset to package** restores the package appearance.

| Control | Range | Effect |
| --- | --- | --- |
| Primary and secondary text colors | Hex colors | Enable custom colors for normal text and muted labels; disable to restore automatic text colors. |
| Background brightness | 20–180% | Adjusts the image brightness. |
| Sidebar color and opacity | 0–100% opacity | Sets the sidebar surface, from transparent to opaque. |
| Sidebar darkness | 0–100% | Darkens the saved color while opacity independently controls transparency. |
| Composer / input box color and opacity | 0–100% opacity | Sets the input surface separately from message boxes. |
| Your message darkness | 0–100% | Adds a dark background behind your messages. |
| AI reply darkness | 0–100% | Adds a dark background behind assistant replies. |
| Page background opacity | 0-100% | Controls dark tint behind Settings, Profile, Projects, and the native Upgrade page. |
| Dialog / project chooser opacity | 0-100% | Controls dialog and project chooser surfaces while preserving nested controls. |
| Thinking / activity darkness | 0–100% | Adds dark backgrounds behind working timers and thinking text. |

For bright images, start with 60–80% message darkness. Enabled darkness uses
light text; 0% returns to the original appearance or saved sidebar surface.
**Reset text colors** restores automatic primary and secondary colors only;
click **Save changes** to apply. Other theme settings stay as they are.
Accent color is also editable. On compatible Codex builds, saving/applying a
customized theme also updates native light/dark Appearance accent settings and
the foreground color when custom text colors are enabled. Secondary text stays
a codexskin override. Native Appearance changes persist after restoring the
official look; use Codex Appearance settings to reset those native colors.
Shared page backgrounds reveal the theme image,
while cards and code blocks retain their own backgrounds for readability.

The preview is approximate: window proportions and the Codex version can
affect the result. Check the applied theme in Codex before finalizing settings.

## Run from source

Requires Node.js 22 or newer. The core uses Node's standard library; esbuild
and postject are development dependencies used to build the executable.

```powershell
npm install
npm test
npm run ui
```

### Build the Windows executable

```powershell
npm run build:exe
```

Output: `dist/codexskin-app.exe`, with README and license notices alongside it.
The build copies the Node.js executable used to run the build and embeds the
application through Node's Single Executable Applications pipeline.

The repository includes the complete Node.js v24.20.0 license. When using a
different Node version, obtain that version's complete official license first:

```powershell
$nodeVersion = node -p process.version
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile "third-party-licenses/Node-$nodeVersion-LICENSE.txt"
```

Update the packaged-runtime version in `THIRD_PARTY_NOTICES.md` before release.
The builder requires the matching Node license file. A release should contain
`codexskin-app.exe`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and the
complete `third-party-licenses` directory. Distribute the folder together.

## CLI

```powershell
node bin/codexskin.mjs --help
node bin/codexskin.mjs doctor
node bin/codexskin.mjs list
node bin/codexskin.mjs import theme.zip
node bin/codexskin.mjs import theme.codextheme
node bin/codexskin.mjs apply theme-id
node bin/codexskin.mjs verify
node bin/codexskin.mjs restore
node bin/codexskin.mjs watch
```

Use the command help for restart, launch, signature, and service options.

## Theme packages

A supported `.codextheme` is a ZIP container and follows the same validation
as `.zip` imports. The extension alone does not guarantee compatibility.
Download a package from [Codex Themes](https://codexthemes.app/themes), then
drop it into the control window or select it with **Import theme**.

A simple ZIP contains `theme.json`, one `background.png`, `background.jpg`,
`background.jpeg`, or `background.webp`, and optionally validated `theme.css`.
Supported DreamSkin manifest packages declare payload files and checksums in
`manifest.json`. Unsupported files or unsafe CSS are rejected.

```json
{
  "schemaVersion": 1,
  "id": "my-theme",
  "name": "My theme",
  "image": "background.png",
  "art": { "taskMode": "full", "dim": 0, "taskDim": 0 },
  "colors": { "accent": "#b7f0ce", "panel": "#191e22" }
}
```

The editor's brightness override replaces legacy image dimming. Resetting to
package appearance restores the package's original settings. Theme rendering depends on Codex DOM selectors and may need updates when Codex changes.

## Local data and security

On Windows, themes and preferences are stored under `%LOCALAPPDATA%\codexskin`.
`CODEXSKIN_HOME` can select an alternative data directory.

The control server binds to loopback with a random token in its URL. The Codex
debugging connection is also local, but other local processes may access an
exposed debugging port. Use this tool only on a machine you trust.

codexskin does not download themes or send telemetry. Imported images and
packages are processed locally. This does not describe network activity of
Codex itself. The dedicated profile and official application remain separate.

## Attribution

Thanks to **Fei-Away and the Codex-Dream-Skin contributors**:
[Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).

codexskin was developed with reference to that project's theme package
contracts, safe-CSS dialect, and selector conventions. It has its own code and
interface. We retain the upstream MIT notice for adapted or reused material;
we do not claim a legally verified clean-room process or upstream endorsement.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[upstream MIT license](third-party-licenses/Codex-Dream-Skin-LICENSE.txt).

## License and image rights

Original codexskin contributions are available under the [MIT License](LICENSE).
Third-party components retain their own licenses and copyright notices. The
Windows executable embeds Node.js; its complete license and bundled notices
are included under `third-party-licenses`.

The software license does **not** grant rights to user-uploaded images,
third-party artwork, character likenesses, or trademarks. Use images you own
or have permission to use; confirm redistribution rights before including
artwork or imported theme packages in a public release.

codexskin is not affiliated with, endorsed by, or sponsored by OpenAI or the
Codex-Dream-Skin developers. Codex, ChatGPT, OpenAI, and other names and marks
belong to their respective owners.

## Validation and limitations

Run `npm test` for the automated suite. Additional local checks are available
in `audit/integration.mjs` and `audit/executable-smoke.mjs`.

Validation on 2 October 2026: 171 automated tests and the executable smoke
check pass. The taskbar identity repair was confirmed visually on the running
Windows app. Historical audit reports describe their own validation snapshots;
their test counts are not the current suite total. Projects, Library, Plugins,
Settings, and Images still need individual visual confirmation across supported
Codex versions. See [the page-surface report](audit/PAGE-SURFACES.md).

The packaged executable is currently unsigned. Public releases should be
signed after the final executable is built.

Windows rendering has been checked against a running Codex instance. macOS



# Third-party notices

## codexskin

Original codexskin contributions are offered under the MIT License in LICENSE.
Third-party material retains its original copyright and license. This document
acknowledges those owners; it does not transfer their rights to codexskin.

## Codex-Dream-Skin — Fei-Away and contributors

Project: https://github.com/Fei-Away/Codex-Dream-Skin
Reference source inspected during development: version 1.5.18.
Copyright (c) 2026 Codex Dream Skin Studio contributors.
License: MIT.
Full notice: third-party-licenses/Codex-Dream-Skin-LICENSE.txt.

codexskin was developed with reference to Codex-Dream-Skin's theme package
contracts, safe-CSS dialect, and renderer selector conventions. It has its own
implementation and UI. The upstream notice is retained for any adapted or
reused material. No claim of an independently verified clean-room process is
made. Attribution does not imply endorsement by Fei-Away or other contributors.

The upstream MIT software license does not automatically cover third-party
artwork, character likenesses, celebrity imagery, or trademarks. Check each
theme's own license before redistribution. Upstream artwork is not licensed
by this attribution notice.

## Node.js and its bundled components

Project: https://nodejs.org/ and https://github.com/nodejs/node
Current packaged runtime: v24.20.0.
The Windows executable embeds a copy of Node.js. Node.js and its bundled
components retain their own licenses, including MIT, BSD, and other terms.
Complete, unmodified notices for this version are included in
third-party-licenses/Node-v24.20.0-LICENSE.txt, retrieved from:
https://raw.githubusercontent.com/nodejs/node/v24.20.0/LICENSE

When rebuilding with another Node.js version, include its complete official
LICENSE as third-party-licenses/Node-<version>-LICENSE.txt and update this
runtime version record. Preserve all bundled dependency notices.

## Build tools

- esbuild: https://github.com/evanw/esbuild — MIT; notice in
  third-party-licenses/esbuild-LICENSE.txt.
- postject: https://github.com/nodejs/postject — its complete distributed
  license notices are retained in third-party-licenses/postject-LICENSE.txt.

These tools are development dependencies, not runtime JavaScript dependencies
of the application. Their notices are provided for attribution and source
redistribution; they do not replace Node.js's bundled component notices.
Other packages installed by npm retain the licenses supplied in their packages.

## Images, themes, and trademarks

User-uploaded and imported images remain subject to their owners' terms.
codexskin's MIT License does not grant permission to redistribute those images,
third-party theme assets, or protected likenesses. Generated sample gradients
are produced by the sample-theme code; imported artwork is separate.

codexskin is unofficial and is not affiliated with, endorsed by, or sponsored
by OpenAI or the Codex-Dream-Skin developers. OpenAI, Codex, ChatGPT, and other
product names and marks belong to their respective owners. No trademark rights
are granted by the software license.

## Redistributing a Windows release

Distribute codexskin-app.exe together with LICENSE, README.md,
THIRD_PARTY_NOTICES.md, and the complete third-party-licenses directory.
Preserve upstream copyright notices and license texts wherever applicable.
This notice describes included licenses; it is not a legal clearance certificate.

paths exist but have not received equivalent live validation. Theme selectors
can break after Codex updates. Automated tests do not prove complete platform
compatibility or legal clearance. The software is provided without warranty.

