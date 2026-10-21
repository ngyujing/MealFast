# MealFast

A small static web app for intermittent fasting, meal logging and weight tracking.
Everything runs in the browser; there is no server and no account.

## Features

- **Fast tab**: tap *I finished eating* to start the timer, *I'm gonna eat* to save the fast.
  Optional time fields let you enter a meal end or eating time you forgot to log.
- **Meals tab**: log name, kcal, protein, carbs and fat, plus an optional photo.
  Photos are shrunk to 1024 px before saving to keep storage small.
- **Weight tab**: log weigh-ins in kg or lb.
- **Analysis tab**: fasting length vs. goal, weight with a 7-day average, daily calories
  vs. target, and macro split. Includes summary stats and plain-language insights.
- **Settings tab**: fasting goal, calorie target, units, JSON backup export/restore.

## Publish on GitHub Pages

1. Merge this branch into the branch you want to publish from (for example `main`).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick your branch and the `/ (root)` folder, then save.
4. Open `https://<your-user>.github.io/<repo>/` after the first deploy finishes.

## Where your data lives

Data is stored in IndexedDB in the browser you use. It is:

- **Not synced** between phone and laptop, or between browsers.
- **Lost** if you clear site data, uninstall the browser, or use a private window.

Use **Settings → Export backup** regularly and keep the JSON file somewhere safe.
Use **Restore from backup** to load it on another device.

## Notes

- Calories and macros are entered by hand. Photos are for your own reference and are not analysed.
- Insights are simple statistics, not medical advice. Check with a clinician before fasting
  if you take medication (for example insulin or sulfonylureas), are pregnant, or have an eating disorder history.
