# Setting up Monika's studio (one-time, ~20 minutes)

## The simplest path (recommended)

1. Install **Claude Code** from https://claude.com/claude-code and sign in.
2. Make an empty folder, e.g. `Documents\OCEAN`.
3. Download **one file** into it:
   https://raw.githubusercontent.com/xWolgan/ocean/main/bootstrap/CLAUDE.md
   (right-click → save as → make sure it is named exactly `CLAUDE.md`).
4. Open PowerShell in that folder (in Explorer: type `powershell` in the
   address bar), run `claude`, and just say **„cześć"**.

Claude reads that file and takes over: installs the tools with her,
walks her through the GitHub sign-in, pulls the whole project into the
folder, starts the app, and introduces the project — all step by step,
in Polish. The manual steps below are only a fallback.

## English (manual fallback)

You'll install four tools once, and after that Claude does everything —
you will never need to type technical commands yourself.

1. **Install Claude Code** — download from https://claude.com/claude-code
   and install like any app. You'll sign in with a Claude account.
2. **Install the tools Claude will use.** Open the app called
   **PowerShell** (press Windows key, type "powershell", Enter) and paste
   these three lines, pressing Enter after each:
   ```
   winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
   winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
   winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
   ```
3. **Make a GitHub account** at https://github.com/signup (free) and tell
   Wolgan your username — he'll add you to the project.
4. **Get the project.** Close PowerShell, open a NEW one, and paste:
   ```
   gh auth login --web --git-protocol https
   ```
   (a browser opens — sign in and approve), then:
   ```
   git clone https://github.com/xWolgan/ocean
   cd ocean
   claude
   ```

That last command starts Claude inside the project. From now on, just
talk to it — in Polish or English. Useful phrases:

- **"Przeczytaj CLAUDE.md i uruchom aplikację"** / "Read CLAUDE.md and
  run the app" — start of every session.
- **"Zacznij nowy eksperyment: ..."** / "Start a new experiment: ..." —
  Claude makes you a safe branch; nothing you do can break the shared app.
- **"Zapisz moją pracę"** / "Save my work".
- **"Opublikuj mój eksperyment do przejrzenia"** / "Publish my experiment
  for review" — Claude opens a Pull Request; Wolgan sees it and you
  decide together to blend it in.
- **"Dogoń wspólną wersję"** / "Catch up with the shared version" —
  pulls the latest main into your workspace.

## Polski

Instalujesz cztery narzędzia raz — potem wszystko robi za Ciebie Claude.

1. **Zainstaluj Claude Code** — pobierz z https://claude.com/claude-code
   i zainstaluj jak zwykłą aplikację. Zalogujesz się kontem Claude.
2. **Zainstaluj narzędzia, z których Claude korzysta.** Otwórz program
   **PowerShell** (klawisz Windows, wpisz "powershell", Enter) i wklej te
   trzy linie, po każdej Enter:
   ```
   winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
   winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
   winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
   ```
3. **Załóż konto GitHub** na https://github.com/signup (darmowe) i podaj
   Wolganowi swoją nazwę użytkownika — doda Cię do projektu.
4. **Pobierz projekt.** Zamknij PowerShell, otwórz NOWY i wklej:
   ```
   gh auth login --web --git-protocol https
   ```
   (otworzy się przeglądarka — zaloguj się i zatwierdź), a potem:
   ```
   git clone https://github.com/xWolgan/ocean
   cd ocean
   claude
   ```

Ostatnia komenda uruchamia Claude'a w projekcie. Od tej pory po prostu z
nim rozmawiasz — po polsku. Przydatne zwroty:

- **"Przeczytaj CLAUDE.md i uruchom aplikację"** — początek każdej sesji.
- **"Zacznij nowy eksperyment: ..."** — Claude tworzy bezpieczną gałąź;
  niczego nie da się zepsuć we wspólnej aplikacji.
- **"Zapisz moją pracę"**.
- **"Opublikuj mój eksperyment do przejrzenia"** — Claude otworzy Pull
  Request; Wolgan go zobaczy i razem zdecydujecie, czy go wmieszać.
- **"Dogoń wspólną wersję"** — pobiera najnowszą wspólną wersję.
