# OCEAN — how to open and play (no installation!)

## English

OCEAN runs entirely in your web browser. There is nothing to install.

1. Open **Google Chrome** (or Edge). Firefox and Safari may work but Chrome
   is the tested one.
2. Go to the link Wolgan sends you (it will look like
   `https://<name>.github.io/<repo>/`).
3. Click once anywhere in the window — this switches the sound on
   (browsers require a click before they allow audio).
   **No sound?** Right-click the browser tab — if it says "Unmute site",
   click it. Then the padlock next to the address → Site settings →
   Sound → Allow, and refresh. The `audio` line in the top-left corner
   tells you what the sound engine is doing (`running` = all good) —
   if it says anything else, send that exact text to Wolgan.
   One more thing worth knowing: **color is pitch** — red is low,
   violet is high, like the spectrum of light.

   The sound engine changed recently: it used to play a sample of the
   world — only 256 particles, picked at random, standing in for
   everything. Now it plays the WHOLE ocean — a few dozen of the
   closest/most important particles as individual voices you can really
   hear moving, and everything else as the true summed voice of the
   whole sea, computed cheaply instead of one-by-one. It sounds fuller,
   and it also means the app now runs on lighter computers — this is the
   fix for the silence you had before, and it's also the path toward it
   running on the Quest headset. Your local 64-voice patch is no longer
   needed once this is merged — don't worry about keeping it around.

   One more change, and it's a big one: **distance is audible now.**
   Sound used to arrive instantly no matter how far away something was —
   only quieter. Now it actually takes time to travel, the way it does
   in real life: something far away flashes now and you hear it ring a
   little later (about 3 milliseconds per meter — for something 10
   meters away, that's a 30ms delay, small but real, and it's WHY things
   now feel like they're really out there in the room instead of just
   "quiet"). Your two ears also hear slightly different things depending
   on where a sound is, which is a big part of how real hearing
   locates things in space. And the room itself answers back: sounds
   bounce off the walls and fade out naturally, like a real space with
   an echo, instead of the old silent void. If you ever want to compare
   to the old, flat-sounding version — for example to describe a
   difference to Wolgan — add `?transport=off` to the end of the link
   (right after the address, before pressing Enter) and reload.
4. Play:
   - **W / A / S / D** — move through the space, **Q / E** — down / up,
     hold **Shift** to move faster, **right-drag** the mouse to look around.
   - **Hold the left mouse button** to play the selected object.
   - The panel on the right is the instrument: the top folders tune the
     environment, the `objects` folder is where instruments live.
   - `create object` → pick a mode → click (or draw) in the field.
   - `scene` → **save scene** downloads a small `.json` file — send it
     back and we can open exactly what you made. **load scene file**
     opens a scene someone sent you.

That's all. If something looks frozen, refresh the page — nothing can
break, and your saved scene files are safe on your disk.

## Polski

OCEAN działa w całości w przeglądarce. Niczego nie trzeba instalować.

1. Otwórz **Google Chrome** (lub Edge).
2. Wejdź w link od Wolgana (będzie wyglądał jak
   `https://<nazwa>.github.io/<repo>/`).
3. Kliknij raz gdziekolwiek w oknie — to włącza dźwięk (przeglądarki
   wymagają kliknięcia, zanim pozwolą grać dźwiękowi).
   **Nie ma dźwięku?** Kliknij prawym przyciskiem na kartę przeglądarki —
   jeśli widzisz "Wyłącz wyciszenie witryny", kliknij to. Potem kłódka
   przy adresie → Ustawienia witryny → Dźwięk → Zezwalaj, i odśwież.
   Linijka `audio` w lewym górnym rogu mówi, co robi silnik dźwięku
   (`running` = wszystko gra) — jeśli pisze coś innego, wyślij ten
   tekst Wolganowi.
   I jeszcze jedno, warto wiedzieć: **kolor to wysokość dźwięku** —
   czerwony jest nisko, fioletowy wysoko, jak widmo światła.

   Silnik dźwięku ostatnio się zmienił: wcześniej grał tylko próbkę
   świata — 256 losowo wybranych cząstek udających całą resztę. Teraz
   gra CAŁY ocean — kilkadziesiąt najbliższych/najważniejszych cząstek
   jako osobne, wyraźnie słyszalne głosy, a całą resztę jako prawdziwy,
   zsumowany głos morza, policzony tanim kosztem zamiast cząstka po
   cząstce. Brzmi pełniej, a przy okazji działa też na słabszych
   komputerach — to naprawia ciszę, którą miałaś wcześniej, i to jest
   też droga do działania na goglach Quest. Twoja lokalna łatka na 64
   głosy nie jest już potrzebna po scaleniu tej zmiany — możesz się nią
   nie przejmować.

   Jest jeszcze jedna zmiana, i to spora: **teraz słychać odległość.**
   Wcześniej dźwięk docierał od razu, niezależnie od tego, jak coś było
   daleko — robił się tylko cichszy. Teraz naprawdę potrzebuje czasu, żeby
   dolecieć, tak jak w prawdziwym świecie: coś odległego błyska TERAZ, a
   dźwięk słychać chwilę PÓŹNIEJ (mniej więcej 3 milisekundy na każdy
   metr — coś oddalonego o 10 metrów spóźni się o 30ms; niewiele, ale
   naprawdę, i właśnie DLATEGO rzeczy zaczynają brzmieć, jakby realnie
   były gdzieś w przestrzeni, a nie tylko "ciszej"). Dwoje uszu słyszy
   też odrobinę co innego, zależnie od tego, skąd dźwięk dochodzi — to
   spora część tego, jak prawdziwy słuch namierza rzeczy w przestrzeni.
   No i sama przestrzeń teraz odpowiada: dźwięki odbijają się od ścian i
   naturalnie wybrzmiewają, jak w prawdziwym pomieszczeniu z echem,
   zamiast dawnej ciszy dookoła. Jeśli kiedyś zechcesz porównać ze starą,
   płaską wersją brzmienia — na przykład żeby opisać różnicę Wolganowi —
   dopisz `?transport=off` na końcu linku (zaraz po adresie, przed
   naciśnięciem Enter) i odśwież stronę.
4. Graj:
   - **W / A / S / D** — poruszanie się, **Q / E** — dół / góra,
     **Shift** — szybciej, **prawy przycisk myszy + ruch** — rozglądanie.
   - **Przytrzymaj lewy przycisk myszy**, żeby zagrać na wybranym obiekcie.
   - Panel po prawej to instrument: górne foldery stroją środowisko,
     folder `objects` to instrumenty.
   - `create object` → wybierz tryb → kliknij (albo narysuj) w polu.
   - `scene` → **save scene** zapisuje mały plik `.json` — odeślij go,
     a otworzymy dokładnie to, co stworzyłaś. **load scene file** otwiera
     scenę, którą ktoś Ci przysłał.

To wszystko. Jeśli coś się zawiesi — odśwież stronę. Nic nie można
zepsuć, a zapisane pliki scen są bezpieczne na Twoim dysku.
