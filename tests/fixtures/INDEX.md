# ISBN lookup fixtures (real responses, captured 2026-11-15)

Captured with `curl -A "Biblioteczka/1.0 (iOS)"` using exactly the requests the iOS app makes:

- BN: `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=<n>&limit=20`, asked first with the ISBN-13, then with the ISBN-10 (app order). Files: `bn/<isbn13>.json` and `bn/<isbn13>.isbn10-<isbn10>.json`. Records are MARC 21 under `bibs[].marc.fields` (NOT `marcRecord`). Empty answer = `{"nextPage": "", "bibs": []}` (35 bytes, HTTP 200).
- e-ISBN: `https://e-isbn.pl/IsbnWeb/api.xml?isbn=<isbn13>` (ONIX 3.0, default namespace `http://ns.editeur.org/onix/3.0/reference`). Not found = HTTP 200 with a `<Header>` only and no `<Product>` (808 bytes).
- Open Library: `https://openlibrary.org/api/books?bibkeys=ISBN:<isbn13>&format=json&jscmd=data`. Not found = HTTP 200 with body `{}`.
- Covers: `https://covers.openlibrary.org/b/isbn/<isbn13>-L.jpg?default=false`. Found = 302 to archive.org (URLSession/curl -L then gets 200 image/jpeg), or a direct 200; missing = 404. The real cover images are not stored (copyright); the tests use synthetic JPEGs of the same size.

Every request returned HTTP 200 except covers (302/404). No request carried anything except the ISBN.
`status.tsv` is the raw log (source, ISBN, URL, status, file).

## What each ISBN demonstrates

| ISBN | Book | BN | e-ISBN | Open Library | Cover | Why it is in the set |
|---|---|---|---|---|---|---|
| 9788375780635 | Sapkowski, *Ostatnie życzenie*, SuperNOWA 2014, 330 pp. | 13: **3 records** / 10: empty | empty | found, no pages, no `cover` key | 302 → 200 | Series (BN 490 `Wiedźmin / Andrzej Sapkowski`, 800 `$t Wiedźmin`, **no volume**). The ISBN query also returns 2 Ukrainian translations that cite this ISBN only in 020 `$z` "(oryginał)" — parser must take the record whose 020 `$a` matches (record 1). 020 `$z 9788375780710 $q t. 1-8` (box set). 250 "Wydanie I w tej edycji." OL title is **NFD** (`życzenie`) → normalize to NFC. OL has no `cover` but the covers endpoint still has an image. |
| 9788380083738 | Rowling, *Harry Potter i więzień Azkabanu*, ill. Jim Kay, Media Rodzina 2017 | 13: 1 record / 10: empty | **found** (only "rich" e-ISBN record in the set) | found, 328 pp., cover | 302 → 200 | BN: 300 `325, [3] strony` (OL says 328 — conflicting page counts), 260 `copyright 2017`, 700 translator/illustrator roles, **no 490/800** (series missing in this BN record). e-ISBN: TitleType 01 + 03 (original title), A01 `Rowling, J. K` (no final dot), Z99 contributors incl. the publisher, Imprint `Media Rodzina,` (trailing comma), City `Poznań :`, PublishingDate `20180809`, Measure 28 cm, no Extent (pages), no Collection. |
| 9788372780140 (ISBN-10 8372780145) | Rowling, *Harry Potter i więzień Azkabanu*, Media Rodzina 2001 | 13: **empty** / 10: **2 records** | empty | found (no pages), cover | 302 → 200, **stored** | ISBN-10-only in BN: proves the second (ISBN-10) BN query is needed. Record 1 has no series; record 2 ("Wydanie poprawione.") has 490 `Harry Potter / J. K. Rowling ; $v 3` + 800 `$t Harry Potter $v 3`, 300 `458, [6] stron`, and 020 `$a 8372780161 (oprawa twarda)` / `$a 8372780145 (oprawa miękka)` — qualifier glued inside `$a`, so ISBN matching must strip it. |
| 9788310139658 | Galewska-Kustra, *Pucio zostaje kucharzem, czyli O radości z jedzenia*, Nasza Księgarnia 2023 | 13: 1 / 10: empty | empty | empty `{}` | 404 | Recent Polish children's book found only in BN. Pages `[30] stron` (bracketed count), 490 `Uczę się z Puciem` without `$v` and without " / " (uncertain series), plus a different 830 series. 700 illustrator `$e Ilustracje` (not an author). |
| 9788308060254 | Sienkiewicz, *Krzyżacy. T. 1*, Wydawnictwo Literackie 2016, 367 pp. | 13: 1 / 10: empty | empty | `{}` | 404 | Volume marker conflict: 245 `$n T. 1` (part of the work) vs series 490/800 `Wielka kolekcja ; $v t. 11` (collection number). 020 `$q (oprawa twarda ; tom 11)`, `$z 9788308060148 (kolekcja)`. 300 `367 stron;` (no space before `;`). |
| 9788308060162 | Sienkiewicz, *Ogniem i mieczem. T. 2*, Wydawnictwo Literackie 2015, 415 pp. | 13: 1 / 10: empty | empty | `{}` | 404 | "t. 2" volume marker in both 245 `$n T. 2` and 800 `$v t. 2`; 020 `$q` split into two subfields (`(oprawa twarda ;`, `tom 2) :`). |
| 9788386530144 (ISBN-10 8386530146) | Mickiewicz, *Dziady : cz. III*, Zysk i S-ka 1994, 220 pp. | 13: empty / 10: 1 | empty | `{}` | 404 | Roman-numeral part marker in 245 `$b cz. III /`; old-style 300 `220, [2] s. ;`, 260 `cop. 1994` with `$e/$f` printer; author 100 without `$e`. ISBN-10-only. |
| 9788385841081 (ISBN-10 8385841083) | Sandemo, *Zęby smoka*, Pol-Nordica 1993, 255 pp. | 13: empty / 10: 1 | empty | `{}` | 404 | Numbered series, ISBN-10-only: 490 `Saga o ludziach lodu / Margit Sandemo ; $v 19`, 800 has the **Norwegian** original series title `Sagaen om Isfolket $v 19` (app prefers 800 `$t` → would name the series in Norwegian), 830 `Saga o Ludziach Lodu ; $v 19`. Publisher `"Pol-Nordica",` with quotes. |
| 9788382400076 | Pichon, *Tomek Łebski ma (chrapkę na) smakołyki*, Zielona Sowa 2021 | 13: 1 | found (minimal) | `{}` | 404 | Children's series with `t. 6`: 490 `Tomek Łebski / Liz Pichon ; $v t. 6` but 800 `$t Tom Gates $v t. 6` (English original series). 300 `221, [11] stron`. e-ISBN: minimal Product (title, one contributor, publisher, dates 20210215, no measures). (BN ISBN-10 not fetched.) |
| 9788372788313 | Głowińska, *Kicia Kocia nie może zasnąć*, Media Rodzina cop. 2013 | 13: 1 | found | `{}` | 404 | Picture book `[24] strony`. e-ISBN quirks: PersonNameInverted is **not inverted** (`Anita Głowińska`, roles A01 + A12), PublisherName `Niebieskie rekordy` differs from BN (Media Rodzina), has Price, ContentAudience and a SupportingResource cover link (elibri.com.pl). (BN ISBN-10 not fetched.) |
| 9788328721166 | Szklarski, *Tomek na Czarnym Lądzie*, Muza 2021, 317 pp. | 13: **2 records** (duplicate) | found (minimal, **no Contributor**) | `{}` | 404 | BN returns two records for the same edition; second one has no 100 author. 020 lists hard and paperback ISBNs. e-ISBN Product has only title + publisher `MUZA S.A.` + date `20211230`. (BN ISBN-10 not fetched.) |
| 9781593279509 | Haverbeke, *Eloquent JavaScript: A Modern Introduction to Programming*, No Starch Press 2018, 472 pp. | empty (13 and 10) | empty | **found** with subtitle | 302 → 200, **stored** | English book only in Open Library; `subtitle` present; `publish_date` `Dec 04, 2018` (free-text date, year must be extracted). |
| 9780140328721 | Dahl, *Fantastic Mr. Fox*, Puffin, 96 pp. | empty | empty | found | **direct 200** (no redirect) | English book only in OL; `publish_date` `October 1, 1988`; cover endpoint answers 200 directly. ISBN-10 starting with 0. |
| 9788399999990 | (does not exist; valid check digit, 978-83 prefix) | empty (13 and 10 = 8399999997) | empty | `{}` | 404 | Not found anywhere: every source returns HTTP 200 with an empty body/structure, covers 404. App result should be `.notFound`, not `.failed`. |

Covers: instead of the real Open Library images (182x276 and 378x500 JPEG) the repository stores synthetic baseline JFIF JPEGs of the same sizes, `covers/synthetic-182x276.jpg` and `covers/synthetic-378x500.jpg`. The app rejects images under 40 px; both pass.

Notes for tests:
- e-ISBN coverage is poor: 4 of 14 ISBNs found, and none contains `<Collection>` (series) or `<Extent>` (pages). The parser paths for those cannot be tested with these real fixtures; a synthetic fixture is needed.
- The e-ISBN header of every real response contained a public BN staff contact (name, phone, e-mail); in this copy it is replaced with placeholders (see below).

## All files
| Source | ISBN | File | HTTP | Size (B) | URL |
|---|---|---|---|---|---|
| bn | 9788375780635 | `bn/9788375780635.json` | 200 | 17794 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788375780635&limit=20` |
| bn | 9788375780635 | `bn/9788375780635.isbn10-8375780634.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8375780634&limit=20` |
| eisbn | 9788375780635 | `eisbn/9788375780635.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788375780635` |
| openlibrary | 9788375780635 | `openlibrary/9788375780635.json` | 200 | 419 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788375780635&format=json&jscmd=data` |
| covers | 9788375780635 | `(not stored)` | 302, followed: 200 (redirects=2, bytes=58762, image/jpeg) | - | `https://covers.openlibrary.org/b/isbn/9788375780635-L.jpg?default=false` |
| bn | 9788380083738 | `bn/9788380083738.json` | 200 | 6108 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788380083738&limit=20` |
| bn | 9788380083738 | `bn/9788380083738.isbn10-8380083733.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8380083733&limit=20` |
| eisbn | 9788380083738 | `eisbn/9788380083738.xml` | 200 | 6082 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788380083738` |
| openlibrary | 9788380083738 | `openlibrary/9788380083738.json` | 200 | 12225 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788380083738&format=json&jscmd=data` |
| covers | 9788380083738 | `(not stored)` | 302, followed: 200 (redirects=2, bytes=73826, image/jpeg) | - | `https://covers.openlibrary.org/b/isbn/9788380083738-L.jpg?default=false` |
| bn | 9788372780140 | `bn/9788372780140.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788372780140&limit=20` |
| bn | 9788372780140 | `bn/9788372780140.isbn10-8372780145.json` | 200 | 12243 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8372780145&limit=20` |
| eisbn | 9788372780140 | `eisbn/9788372780140.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788372780140` |
| openlibrary | 9788372780140 | `openlibrary/9788372780140.json` | 200 | 12015 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788372780140&format=json&jscmd=data` |
| covers | 9788372780140 | `(not stored; synthetic-182x276.jpg)` | 302, followed: 200 (redirects=2, bytes=20884, image/jpeg) | 20884 | `https://covers.openlibrary.org/b/isbn/9788372780140-L.jpg?default=false` |
| bn | 9788310139658 | `bn/9788310139658.json` | 200 | 4683 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788310139658&limit=20` |
| bn | 9788310139658 | `bn/9788310139658.isbn10-8310139659.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8310139659&limit=20` |
| eisbn | 9788310139658 | `eisbn/9788310139658.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788310139658` |
| openlibrary | 9788310139658 | `openlibrary/9788310139658.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788310139658&format=json&jscmd=data` |
| covers | 9788310139658 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788310139658-L.jpg?default=false` |
| bn | 9788308060254 | `bn/9788308060254.json` | 200 | 5042 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788308060254&limit=20` |
| bn | 9788308060254 | `bn/9788308060254.isbn10-8308060250.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8308060250&limit=20` |
| eisbn | 9788308060254 | `eisbn/9788308060254.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788308060254` |
| openlibrary | 9788308060254 | `openlibrary/9788308060254.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788308060254&format=json&jscmd=data` |
| covers | 9788308060254 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788308060254-L.jpg?default=false` |
| bn | 9788308060162 | `bn/9788308060162.json` | 200 | 5677 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788308060162&limit=20` |
| bn | 9788308060162 | `bn/9788308060162.isbn10-8308060161.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8308060161&limit=20` |
| eisbn | 9788308060162 | `eisbn/9788308060162.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788308060162` |
| openlibrary | 9788308060162 | `openlibrary/9788308060162.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788308060162&format=json&jscmd=data` |
| covers | 9788308060162 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788308060162-L.jpg?default=false` |
| bn | 9788386530144 | `bn/9788386530144.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788386530144&limit=20` |
| bn | 9788386530144 | `bn/9788386530144.isbn10-8386530146.json` | 200 | 3486 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8386530146&limit=20` |
| eisbn | 9788386530144 | `eisbn/9788386530144.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788386530144` |
| openlibrary | 9788386530144 | `openlibrary/9788386530144.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788386530144&format=json&jscmd=data` |
| covers | 9788386530144 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788386530144-L.jpg?default=false` |
| bn | 9788385841081 | `bn/9788385841081.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788385841081&limit=20` |
| bn | 9788385841081 | `bn/9788385841081.isbn10-8385841083.json` | 200 | 4471 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8385841083&limit=20` |
| eisbn | 9788385841081 | `eisbn/9788385841081.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788385841081` |
| openlibrary | 9788385841081 | `openlibrary/9788385841081.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788385841081&format=json&jscmd=data` |
| covers | 9788385841081 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788385841081-L.jpg?default=false` |
| bn | 9781593279509 | `bn/9781593279509.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9781593279509&limit=20` |
| bn | 9781593279509 | `bn/9781593279509.isbn10-1593279507.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=1593279507&limit=20` |
| eisbn | 9781593279509 | `eisbn/9781593279509.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9781593279509` |
| openlibrary | 9781593279509 | `openlibrary/9781593279509.json` | 200 | 2072 | `https://openlibrary.org/api/books?bibkeys=ISBN:9781593279509&format=json&jscmd=data` |
| covers | 9781593279509 | `(not stored; synthetic-378x500.jpg)` | 302, followed: 200 (redirects=2, bytes=51200, image/jpeg) | 51200 | `https://covers.openlibrary.org/b/isbn/9781593279509-L.jpg?default=false` |
| bn | 9780140328721 | `bn/9780140328721.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9780140328721&limit=20` |
| bn | 9780140328721 | `bn/9780140328721.isbn10-0140328726.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=0140328726&limit=20` |
| eisbn | 9780140328721 | `eisbn/9780140328721.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9780140328721` |
| openlibrary | 9780140328721 | `openlibrary/9780140328721.json` | 200 | 4149 | `https://openlibrary.org/api/books?bibkeys=ISBN:9780140328721&format=json&jscmd=data` |
| covers | 9780140328721 | `(not stored)` | 200 | - | `https://covers.openlibrary.org/b/isbn/9780140328721-L.jpg?default=false` |
| bn | 9788399999990 | `bn/9788399999990.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788399999990&limit=20` |
| bn | 9788399999990 | `bn/9788399999990.isbn10-8399999997.json` | 200 | 35 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=8399999997&limit=20` |
| eisbn | 9788399999990 | `eisbn/9788399999990.xml` | 200 | 808 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788399999990` |
| openlibrary | 9788399999990 | `openlibrary/9788399999990.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788399999990&format=json&jscmd=data` |
| covers | 9788399999990 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788399999990-L.jpg?default=false` |
| bn | 9788382400076 | `bn/9788382400076.json` | 200 | 4714 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788382400076&limit=20` |
| eisbn | 9788382400076 | `eisbn/9788382400076.xml` | 200 | 2962 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788382400076` |
| openlibrary | 9788382400076 | `openlibrary/9788382400076.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788382400076&format=json&jscmd=data` |
| covers | 9788382400076 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788382400076-L.jpg?default=false` |
| bn | 9788372788313 | `bn/9788372788313.json` | 200 | 4131 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788372788313&limit=20` |
| eisbn | 9788372788313 | `eisbn/9788372788313.xml` | 200 | 5510 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788372788313` |
| openlibrary | 9788372788313 | `openlibrary/9788372788313.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788372788313&format=json&jscmd=data` |
| covers | 9788372788313 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788372788313-L.jpg?default=false` |
| bn | 9788328721166 | `bn/9788328721166.json` | 200 | 7128 | `https://data.bn.org.pl/api/institutions/bibs.json?isbnIssn=9788328721166&limit=20` |
| eisbn | 9788328721166 | `eisbn/9788328721166.xml` | 200 | 3047 | `https://e-isbn.pl/IsbnWeb/api.xml?isbn=9788328721166` |
| openlibrary | 9788328721166 | `openlibrary/9788328721166.json` | 200 | 2 | `https://openlibrary.org/api/books?bibkeys=ISBN:9788328721166&format=json&jscmd=data` |
| covers | 9788328721166 | `(not stored)` | 404 | - | `https://covers.openlibrary.org/b/isbn/9788328721166-L.jpg?default=false` |

## Changes made for the repository copy

- In every `eisbn/*.xml` the `<Header>` contact data (`ContactName`, `EmailAddress`) was replaced with neutral placeholders (`Kontakt testowy, tel. +48000000000`, `kontakt@example.invalid`). In `eisbn/9788372788313.xml` the publisher's description (`<Text>`) and the cover link (`<ResourceLink>`) were replaced with placeholders. The real cover images were not kept (see above). Nothing else was changed in the real responses.

## Synthetic fixtures (`synthetic-*`)

Hand-written files for parser paths that no real response covers. Expected results are asserted in `tests/test_bn.py`, `tests/test_onix.py` and `tests/test_openlibrary.py`.

| File | What it exercises |
|---|---|
| `bn/synthetic-verified-1.json` | Spec example 1: 020 `$a` with hyphens and qualifier, 264 with quoted publisher, 490 with " / " and `$v t. 1`, 800 without `$v` (volume from 490). |
| `bn/synthetic-verified-2.json` | Spec example 2: bracketed title, 700 author found by `$e Autor`, 260 without `$b` skipped, volume range `t. 1-8`, `publicationYear` wins over imprint `$c`. |
| `bn/synthetic-decomposed.json` | Decomposed (NFD) Polish letters everywhere, initial „Ć.” kept, `©` and quotes in the publisher, Roman volume „Księga V. Pani”, ISBN-10 match. |
| `bn/synthetic-malformed.json` | Truncated JSON → notFound. |
| `eisbn/synthetic-collection-extent.xml` | Spec ONIX example: `<Collection>` series + PartNumber, TitlePrefix/TitleWithoutPrefix, contributor roles, `<Extent>` types 08/00, dates 19/01/09. |
| `eisbn/synthetic-quirks.xml` | Empty `PersonName` (fix §9.5), publisher „©”, numeric character references (NFD → NFC), out-of-range dates, two `<Product>` elements merged. |
| `eisbn/synthetic-malformed.xml` | Truncated XML with a `<Product>` → notFound. |
| `openlibrary/synthetic-decomposed.json` | NFD title with „(Polish Edition)”, several authors/publishers (first wins), free-text date. |
| `openlibrary/synthetic-wrong-type.json` | `"number_of_pages": "12"` → the whole entry fails to decode (iOS behaviour). |
| `openlibrary/synthetic-malformed.json` | Truncated JSON → notFound. |
