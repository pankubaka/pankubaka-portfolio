# Panel /admin – jednorazowa konfiguracja na Vercelu

1. Wrzuć do projektu pankubaka-www wszystkie pliki z tej paczki (z zachowaniem folderu `api/`):
   index.html, index-pl.html, admin.html, api/works.js, package.json, logo.png.
2. Vercel → projekt pankubaka-www → zakładka **Storage** → **Create** → **Blob** → połącz z projektem.
   (Vercel sam doda zmienną BLOB_READ_WRITE_TOKEN.)
3. Settings → **Environment Variables** → dodaj `ADMIN_PASSWORD` = Twoje hasło do panelu.
4. Zrób **Redeploy**.
5. Wejdź na https://www.zatrudnij.pankubaka.pl/admin.html, zaloguj się hasłem, wklej linki, kliknij „Zapisz i opublikuj”.

Dopóki w panelu nic nie zapiszesz, strona pokazuje przykładowe prace z listy PRACE w index.html.
Zmiany z panelu widać na stronie po maksymalnie minucie.
