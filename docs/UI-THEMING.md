# UI Theming & Mobile — Proxmox Dashboard

Dokumen ini menjelaskan sistem tema (Orange default / Hijau opsional), cara kerja,
cara menambah tema baru, dan perilaku responsif mobile. Ditulis agar aman diubah
tanpa merusak UI yang sudah berjalan.

---

## 1. Ringkasan

- **Tema default = Orange (gelap)** — tidak berubah dari versi sebelumnya. Ini juga **fallback**:
  bila fitur tema gagal / localStorage kosong, UI tampil Orange gelap seperti semula.
- **Tema Hijau Cerah = opsional & TERANG** (latar putih, teks gelap, aksen hijau), diaktifkan
  lewat toggle 🎨 di menu ⋮. Pilihan disimpan di `localStorage` (`pve_dash_theme`).
  Layar terminal/VNC (`bg-black`) & teks toast tetap seperti semula.
- **Mobile**: tombol aksi utama (`+ VM`, `+ CT`) tetap terlihat; tombol sekunder
  (Terminal Node, Ganti Password, Keluar, Tema) dipindah ke **menu dropdown ⋮**.

---

## 2. Cara kerja tema (prinsip: tanpa mengubah class di JS)

Warna aksen tersebar sebagai utility Tailwind (`bg-orange-600`, `text-sky-400`, dst.)
di `index.html`, `app.js`, dan `features.js` — **puluhan titik**. Mengganti semuanya
manual berisiko lupa/typo.

Solusinya: **remap CSS berbasis atribut**, bukan mengganti class.

1. `app.js` menaruh/menghapus atribut pada `<html>`:
   - Hijau  → `document.documentElement.setAttribute('data-theme','green')`
   - Orange → atribut dihapus (kembali ke Tailwind CDN default).
2. `style.css` punya blok `html[data-theme="green"] .<utility> { ... !important }`
   yang me-remap **hanya** utility warna yang benar-benar dipakai:
   - `orange` (primary) → **emerald**
   - `sky` (CT/secondary) → **teal**

Karena JS tidak menyentuh nama class sama sekali, **risiko regresi minimal** dan
fallback ke Orange otomatis (cukup hapus atribut).

### Palet Hijau
| Peran | Variabel | Hex |
|---|---|---|
| primary 400 | `--p-400` | `#34d399` |
| primary 500 | `--p-500` | `#10b981` |
| primary 600 | `--p-600` | `#059669` |
| secondary 400 | `--s-400` | `#2dd4bf` |
| secondary 500 | `--s-500` | `#14b8a6` |
| secondary 600 | `--s-600` | `#0d9488` |

---

## 3. Menambah tema baru (mis. "blue")

1. Di `public/style.css`, salin blok `html[data-theme="green"] { ... }` menjadi
   `html[data-theme="blue"]` dan ubah nilai variabel `--p-*` / `--s-*`.
2. Salin seluruh baris remap utility (`html[data-theme="green"] .bg-orange-600 {...}`)
   menjadi `html[data-theme="blue"] .bg-orange-600 {...}`, dst.
3. Di `public/app.js`, ubah `toggleTheme()` menjadi siklus 3 nilai
   (`orange → green → blue → orange`) atau ganti jadi menu pilih tema.
4. Naikkan versi cache-bust di `index.html` (`?v=N`).

> Bila utility warna baru muncul di kode (mis. dipakai `bg-orange-700`), tambahkan
> baris remap-nya. Cek utility yang dipakai:
> ```bash
> grep -ohE '(bg|text|border|hover:bg|focus:border)-(orange|sky)-[0-9]+(/[0-9]+)?' public/*.html public/*.js | sort -u
> ```

---

## 4. Responsif mobile

- Header memakai `gap-2 sm:gap-3`; status WS (`realtime/offline`) disembunyikan di
  layar `<640px` (`hidden sm:flex`) agar tak menyempitkan tombol.
- Tombol sekunder → **dropdown** `#menuDrop` (absolute, `right-0`), dibuka `#btnMenu` (⋮).
  Menutup saat: klik di luar, tekan `Esc`, atau memilih salah satu item.
- `style.css` `@media (max-width:640px)`: memperkecil judul, memotong label node dengan
  ellipsis, dan membuat kolom pencarian full-width.

---

## 5. Cache-bust

Setiap perubahan `app.js`/`features.js`/`style.css` **wajib** menaikkan query versi di
`index.html`:
```html
<script src="/features.js?v=8"></script>
<script src="/app.js?v=8"></script>
```
Tanpa ini, browser HP sering menahan file lama (penyebab "tombol tidak muncul").
Setelah deploy, lakukan **hard-refresh** di HP.

---

## 6. Kembali ke UI lama (fallback manual)

Fitur tema tidak menghapus apa pun dari UI lama. Untuk memaksa Orange:
- Lewat UI: buka menu ⋮ → 🎨 hingga label "Tema: Orange".
- Lewat console browser: `localStorage.removeItem('pve_dash_theme'); location.reload();`

Bila ingin menonaktifkan seluruh fitur tema, hapus blok `html[data-theme="green"]`
di `style.css` dan pemanggilan `initTheme()`/`initMenu()` di `app.js` — sisa UI tetap jalan.
