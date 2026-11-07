# Library pack

The code that draws the common library pack: ground, floors, walls, roof, water, sky, plants, props, icons and fx. That's 35 assets in `library/`, each with `provenance.recipe` pointing at its file here. They are drawn from palette letters (`pap-night`), so there are no model calls.

```sh
node scripts/library-pack/all.mjs              # every wave, plus contact sheets and sheets/index.html
node scripts/library-pack/run.mjs w3-icons     # one or more waves
node scripts/library-pack/view.mjs coin-spin   # 6x preview of the given assets
```

Output goes to `out/library-pack/` (gitignored; set `OUT` to change it): `assets/<id>/asset.json` and `sheet.png`, `index-rows.json`, and `sheets/`. Each asset is checked against the PAP standard as it is built.

To change an asset, edit its recipe, rerun the script, look at the sheet, then copy `assets/<id>/` over `library/<id>/`.

| File | What |
|---|---|
| `lib.mjs` | harness: grid helpers, the `asset()` builder, sheets and contact sheets |
| `ground.mjs` | shared painter for tileable ground and wall sets |
| `w1-ground`, `w1-build`, `w1-sky`, `w1-plants` | textures, ground, sky and plants |
| `w2-small`, `w2-big` | props |
| `w3-icons` | icons and the spinning coin |
| `w4-fx` | fx sprites |
