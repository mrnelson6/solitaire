# Solitaire

A mobile-first solitaire web app that installs to the home screen on iOS and Android (PWA).
No build step and no dependencies: just static files you can host on GitHub Pages.

- Four games: **Klondike** (draw 1 or draw 3), **Spider** (1, 2 or 4 suits), **FreeCell** and **Yukon**
- Drag cards, or tap a card to send it to the best spot
- Unlimited undo, hints, restart the same deal, and a one-tap Finish once the game is won
- Optionally moves cards to the foundations automatically when it's safe
- Wins, win rate and best time for each game and option, kept on the device
- Auto-save/resume, table and card-back colors, dark mode, and offline play

## Run locally

```sh
python -m http.server 8000
```

Then open http://localhost:8000. A plain `file://` URL won't work because the app uses JS modules and a service worker.

## Deploy to GitHub Pages

1. Create a GitHub repo and push these files to the `main` branch.
2. In the repo, go to **Settings → Pages**, set **Source** to "Deploy from a branch", and pick `main` / `/ (root)`.
3. After a minute, the site is live at `https://<user>.github.io/<repo>/`.
4. For a custom domain, add a `CNAME` file with the domain (for example `solitaire.example.com`) and point a DNS CNAME record at `<user>.github.io`.

To install it as an app:
- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** use the "Install" button on the home screen, or ⋮ → Install app.

Pushing to `main` updates the site within about a minute. Installed apps pick up the change the next time they're opened while online.

## Choosing a game

Tap a game on the home screen to see its rules and stats, pick its option (draw count or number of suits), and deal.
The same options are also under **Settings**. A change applies from the next deal, not to a game in progress.

## Files

- `js/games.js`: the rules for every game (dealing, legal moves, hints, auto-moves). No DOM code.
- `js/app.js`: the table layout, dragging and tapping, undo, saving, and settings.
- `css/styles.css`: styles, including the light and dark themes and the table and card colors.

To add a game, add an entry to `VARIANTS` and a pile layout to `makePiles()` in `js/games.js`, extend the deal in `newGame()` and the rules in `canPickUp()` and `canMove()`, then add a button for it in `index.html`.

## Notes

- The timer starts with your first move, and pauses when you leave the app or tap the timer.
- The Finish button appears when nothing is face down, the stock is empty, and every column is in descending order. From there the game can always be won.
- Spider follows the traditional rule that every column must have a card before you deal from the stock.
- Keyboard shortcuts on desktop: Z undoes, H gives a hint, D or Space deals from the stock, F finishes, P pauses, and Esc goes back to the menu. If "Tap a card to move it" is off, double-clicking a card sends it to a foundation.
