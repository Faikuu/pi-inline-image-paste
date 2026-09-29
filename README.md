# @faiku/pi-inline-image-paste

A [pi](https://github.com/earendil-works/pi) extension that attaches pasted images to your message as real image content, instead of dropping a temporary file path into the text.

Out of the box, pasting a screenshot into pi inserts the path of a file in your temp directory. With this extension the image itself is queued: a thumbnail appears above the editor, a `[image N]` token marks its place in your text, and on send the token is swapped for the image bytes. The model receives the picture; the transcript shows a short note describing it.

## What it does

| Action | Result |
|---|---|
| `ctrl+v` with an image on the clipboard | Image queued, thumbnail shown, `[image N]` inserted at the cursor |
| `ctrl+v` with text on the clipboard | Pasted as text, exactly as pi does it |
| Drag and drop an image file into the terminal, or paste its path | The image is queued and the path is replaced |
| A terminal that streams image bytes into the paste | The image is queued from the raw byte stream |
| `/image-attach shot.png` | Same, by hand |

The paste keybinding is whatever `app.clipboard.pasteImage` is bound to in your keybindings, so a rebinding is picked up automatically. It defaults to `ctrl+v` (`alt+v` on Windows). **On macOS use `ctrl+v`, not `cmd+v`**: terminals deliver `cmd+v` as a text paste, and there is usually nothing to read from the clipboard in that case.

## Commands

| Command | Effect |
|---|---|
| `/image-attach <path> [path…]` | Attach image files to the next message |
| `/image-list` | Show the queued images with their number, size, and format |
| `/image-clear` | Drop every queued image and remove the tokens from the editor |
| `/image-notes` | Toggle the `[image N: 1440x900 PNG, 231 KB]` note in sent messages |

## The preview

Above the editor you get a strip of thumbnails, drawn with the terminal's own graphics protocol (kitty, iTerm2, WezTerm, Ghostty) and a compact `#1 1440x900 PNG` label everywhere else, plus a caption:

```
 #1 screenshot.png  #2 diagram.png  +1 more
 3 images attached · 1.2 MB · /image-clear to remove
> compare these two [image 1] [image 2] [image 3]
```

## Behaviour worth knowing

- **The token is the manifest.** An image is queued when its `[image N]` token is in the editor, and dropped as soon as you delete that token: the thumbnail leaves with it, without waiting for the message. Clearing the editor therefore drops the queued images too; re-paste or use `/image-attach` to get them back. A submitted message that somehow has no token (RPC, print mode) still sends everything queued, so nothing is lost on a path with no editor to watch.
- **pi does not render images in the transcript.** It only draws the text part of a user message, so each image leaves a one-line note behind. `/image-notes` turns the notes off; the images are still sent, and a message made only of images falls back to `(2 images attached)` so the turn is not blank.
- **Queued images are cleared on send**, including while the model is streaming (`ctrl+v` mid-answer works: the image joins the steered or follow-up message).
- **Limits** are enforced per message: 20 images and 32 MB by default. The extension asks before queueing anything over the limit.
- **Extension commands run before the `input` event**, so typing `/model-global` never swallows your attachments.
- **Formats**: PNG, JPEG, GIF, and WebP. Anything else is rejected with a message rather than attached.
- **Images are never written to disk.** Bytes are held in memory and passed straight to the model.
- The raw-stdin capture only ever withholds an image paste; every other byte is forwarded to pi's input pipeline unchanged and in its original order, and the original listeners are restored on `session_shutdown`, including on `/reload`.

## Configuration

Optional block in `<agent-dir>/settings.json` (default `~/.pi/agent/settings.json`):

```json
{
  "imagePaste": {
    "maxImages": 20,
    "maxTotalMb": 32,
    "showNotes": true,
    "showPreview": true,
    "maxThumbnails": 4
  }
}
```

`showNotes` is the only key `/image-notes` writes; it is merged into the file, leaving everything else alone.

## Install

From npm (recommended):

```bash
pi install npm:@faiku/pi-inline-image-paste
```

Try it for a single run without installing:

```bash
pi -e npm:@faiku/pi-inline-image-paste
```

From a local checkout:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-inline-image-paste
```

Per project, or for one run:

```bash
pi --extension ./index.ts
```

```bash
# add to <project>/.pi/settings.json
{ "extensions": ["/absolute/path/to/pi-inline-image-paste"] }
```

## Development

```bash
npm install          # dev-only: types for typechecking
npm test             # unit tests for sniffing, capture, attachments, config
npm run typecheck    # tsc --noEmit
```

Layout: `index.ts` (wiring: events, capture, editor reconciliation, commands), `lib/images.ts` (magic-byte sniffing, dimensions, formatting), `lib/raw-stdin.ts` (byte-level paste interception), `lib/paste.ts` (paste keybinding and dropped-path parsing), `lib/clipboard.ts` (clipboard backends), `lib/attachments.ts` (tokens, notes, the send-time transform), `lib/attachment-bar.ts` (thumbnail strip), `lib/config.ts` and `lib/settings.ts` (settings).

The extension ships as TypeScript source — pi loads `.ts` entry points directly, so there is no build step.

### A note on the capture layer

pi reads stdin and decodes every chunk as UTF-8 before an extension sees it, which turns image bytes into replacement characters. So a terminal that streams an image into the paste cannot be handled through pi's string-level input hook. This extension therefore takes over the `data` listeners on `process.stdin` for the duration of the session, inspects raw bytes, and forwards everything that is not an image paste to the listeners it displaced. In practice the clipboard and drag-and-drop paths carry the feature on their own; the raw path exists so a byte-streaming terminal is not left with a corrupted paste in the editor.

## License

MIT
# pi-inline-image-paste
