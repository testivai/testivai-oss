---
"@testivai/witness": patch
---

The `/testivai` skill (`testivai init-claude`): `/testivai report` shows the report with its screenshots. It runs `npx testivai report --share` and shows `visual-report/share.html`, every image inlined, since the app's side panel cannot load `index.html`'s `images/` folder. It never does when `.testivai/config.json` sets `shareUploadCommand`, which would upload the report: then it gives the path of `index.html`. `/testivai status` also names restyled elements (`dom.styleChanges`) and a page shift when the DOM changed too. Run `npx testivai init-claude --force` to update an installed skill.
