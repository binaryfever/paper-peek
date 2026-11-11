# Paper Peek

Paper Peek shows a Paper artboard beside your code.

The bar widget is a dot. The tooltip reads Live, Not live, or Off. Click the dot to open the drawer. Press `SUPER + SHIFT + H` to open it, and press that hotkey again to close it.

The drawer slides in from the right. The header is two lines: the artboard name, then the project and page it comes from. Under the shot, the same column lists that page's artboards, and a click loads that artboard. A click on the artboard itself opens it at the size of the screen, and a click anywhere brings the drawer back. The expand control in the artboard's top right corner does the same. Browse opens the project list.

![Drawer open on the current artboard](docs/drawer.png)

## Requirements

You need Omarchy 4. Paper Desktop has to be open, with a file already loaded.

Paper Peek reads the open file. It does not open a file in Paper. A screenshot needs that file to already be open.

## Install

Add the plugin from its git repository.

```bash
omarchy plugin add https://github.com/binaryfever/paper-peek
```

The command clones the repository and validates `manifest.json`. Enable Paper Peek when the command asks. You can also enable it later.

```bash
omarchy plugin enable binaryfever.paper-peek
```

The dot's default place is the left of the bar.

Remove the plugin with this command.

```bash
omarchy plugin remove binaryfever.paper-peek
```

The plugin id is `binaryfever.paper-peek`.

Paper Peek is published from [binaryfever/paper-peek](https://github.com/binaryfever/paper-peek), which carries only the files an install needs. The work lives in [binaryfever/omarchy-paper-peek](https://github.com/binaryfever/omarchy-paper-peek): the decision records, the notes on Paper's MCP server, and the tests.

## Hotkeys

`SUPER + SHIFT + H` toggles the peek. The hotkey runs `omarchy-shell binaryfever.paper-peek toggle`.

`browserHotkey` is empty until you set it. An empty value adds no hotkey. A set value runs `omarchy-shell binaryfever.paper-peek browser`.

While the drawer shows the artboard, Space opens it at the size of the screen. Escape closes the drawer. Return opens the project browser.

The open drawer does not hold your keyboard. It takes the keys when it opens, so Escape and Space work straight after the hotkey, and it gives them back the moment you click another window. Click the drawer again to steer it with the keys. `SUPER + SHIFT + H` closes it from anywhere, whatever has focus.

While the artboard fills the screen, a click anywhere closes it, and so do Escape and Space. The drawer comes back on the same artboard, with the rows where you left them. Paper is not called, because the big view reads the JPEG already in the cache.

`omarchy-shell binaryfever.paper-peek zoom` opens the artboard at the size of the screen, and closes it again. Bind that command to a key of your own if you want the big view without the drawer's.

## Settings

Change Paper Peek in `~/.config/paper-peek/settings.json`. With no file, Paper Peek keeps the defaults in the table. An invalid value falls back to that default. The shell logs a warning that starts with `paper-peek:`. Saving a new `drawerSide` moves the open drawer without a shell restart.

`defaultMode` applies the next time you open Paper Peek. It does not move a peek that is already open.

| Key | Default | What it sets |
| --- | --- | --- |
| `toggleHotkey` | `SUPER + SHIFT + H` | Hotkey that toggles the peek |
| `browserHotkey` | empty | Hotkey that opens the project browser. Empty adds no hotkey |
| `drawerSide` | `right` | `left` or `right` |
| `drawerWidth` | `480` | Drawer width in pixels, from 240 to 1200 |
| `refreshIntervalMs` | `2000` | Milliseconds between Paper checks while the drawer is open, from 500 to 60000. A closed drawer checks at a fifteenth of that rate, because the bar's dot is the only thing reading it. Opening the drawer checks at once |
| `defaultMode` | `drawer` | `drawer` or `dock` on the next open |
| `paperAddress` | `127.0.0.1:29979` | Paper host and port. Requests use that host and port on the path `/mcp` |
| `cacheBudgetMb` | `200` | Cap on `shots/`, in megabytes, from 0 to 1048576. 0 keeps the current artboard and the five recents |

Leave a key out to keep its default. `PAPER_MCP_URL` overrides `paperAddress` when you run `scripts/paper-fetch` yourself. When this file exists, the drawer uses the address from the file.

```json
{
  "drawerSide": "left",
  "drawerWidth": 560
}
```

## License

MIT. See `LICENSE`.
