# Tempahan melalui email (Power Automate)

Setup ni dibuat sekali sahaja. Selepas itu, sesiapa boleh tempah bilik dengan hantar atau cc email ke alamat booking. Tempahan masuk ke RoomFlow sebagai **Pending**, dan Receptionist approve atau reject.

## Sebelum mula
1. **Alamat booking**: buat shared mailbox, contoh `bilik@syarikat.com`. Receptionist kena ada akses ke mailbox ni.
2. **Lesen**: Power Automate. Action HTTP ialah premium, jadi semak akaun anda.
3. **RoomFlow**: buka **Settings → Email booking**.
   - Enable toggle **Accept bookings by email**.
   - Salin **Endpoint** dan **Secret**.
   - Tetapkan **Working hours** (contoh 08:00 dan 18:00).

## Format email
Subject mesti ikut format ni:
```
[BOOK] Bilik 101 | 25/11/2026 | 14:00-15:00 | Tajuk mesyuarat
```
Untuk batal:
```
[CANCEL] Bilik 101 | 25/11/2026 | 14:00-15:00
```
- Nama bilik boleh nombor (`101`) atau nama penuh bilik.
- Tarikh ikut format `DD/MM/YYYY`. Masa ikut format 24 jam.
- Tajuk wajib untuk `[BOOK]`.
- Elakkan tanda petikan (`"`) dalam subject.

## Flow 1: Terima dan hantar ke RoomFlow

**Trigger: When a new email arrives (V3)**
- Mailbox: `bilik@syarikat.com`
- Subject filter: kosongkan

**Condition** (Advanced mode). Tapis email format booking dan abaikan email dari mailbox sendiri:
```
@and(
  or(contains(toUpper(triggerOutputs()?['body/subject']),'[BOOK]'), contains(toUpper(triggerOutputs()?['body/subject']),'[CANCEL]')),
  not(equals(toLower(triggerOutputs()?['body/from']), 'bilik@syarikat.com'))
)
```

**Dalam "If yes":**

**HTTP**
- Method: `POST`
- URI: alamat endpoint dari Settings, contoh `https://roomflow-xxx.up.railway.app/api/inbound/email`
- Headers:
  - `Content-Type`: `application/json`
  - `X-Inbound-Secret`: secret dari Settings
- Body:
```
{
  "from": "@{replace(triggerOutputs()?['body/from'],'"','\"')}",
  "subject": "@{replace(triggerOutputs()?['body/subject'],'"','\"')}"
}
```

**Send an email (V2)** (Outlook). Ini hantar balasan kepada pengirim.
- Klik **Configure run after** pada action ni, pilih **is successful** dan **has failed**. Ini penting, sebab RoomFlow hantar status 4xx bila tempahan ditolak.
- To: `@{triggerOutputs()?['body/from']}`
- Subject: `RE: @{triggerOutputs()?['body/subject']}`
- Body: `@{body('HTTP')?['message']}`

## Flow 2 (pilihan): Notify Receptionist bila ada tempahan baru
Ini sama dengan Flow 1, tapi action kedua ialah Teams message atau email ke Receptionist bila `body('HTTP')?['status']` ialah `Pending`. Kalau tak perlu, skip.

## Cara test
1. Dari akaun Ali (Staff), hantar email ke `bilik@syarikat.com` dengan subject:
   `[BOOK] Bilik 101 | <tarikh esok> | 10:00-11:00 | Test email`
2. Dalam RoomFlow, buka **Bookings**. Booking patut muncul sebagai **Pending approval**.
3. Log **Settings → Email booking → Recent emails** tunjuk hasil.
4. Ali patut terima email balasan: "diterima dan menunggu kelulusan".
5. Receptionist login, klik **Approve** di Bookings.
6. Test slot bertindih: hantar email untuk slot yang sama. Ali patut terima balasan dengan slot kosong.

## Masalah biasa
- **Balasan tak sampai**: semak "Configure run after" pada action Send an email.
- **401 Secret tidak sah**: salin secret semula dari Settings. Kalau pernah tekan Regenerate, flow kena update.
- **400 Subject tidak sah**: semak format subject. Elakkan tanda petikan.
- **Tiada apa berlaku**: semak run history Power Automate. Pastikan toggle **Accept bookings by email** dalam RoomFlow ON.
- **Booking tak muncul**: kalau toggle approval OFF, booking terus Confirmed. Kalau ON, ia Pending dan hanya approver boleh lihat di Bookings.
