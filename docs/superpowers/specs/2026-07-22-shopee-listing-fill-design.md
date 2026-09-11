# Shopee listing content and variation fill

## Goal

Extend the current Manifest V3 uploader so one run can fill a Shopee listing from
two user-selected workbooks and the selected product-image folder. The extension
must not submit the product; the seller reviews the filled form and saves it.

## Sources

1. `abura.hcm.xlsx` is the listing-content source. Its header row includes `ID
   LISTING`, `Tiêu Đề`, `Bài Đăng`, `PHÂN LOẠI 1 (copy đăng Shopee)`, and
   `PHÂN LOẠI 2 (copy đăng Shopee)`.
2. `FILE GIÁ DORIS.xlsx` is the SKU source. The primary `SKU` column and `TÊN
   SẢN PHẨM` column are indexed across worksheets.
3. The user selects one product folder. It contains `*-ANH-BIA`, `*-g1` through
   `*-gN`, plus a variation image with a filename ending in the unaccented slug
   of a variation-1 value, e.g. `-sa-chanh.jpg` for `Sả Chanh`.

Browser extensions cannot access the fixed Windows paths directly. The user loads
the two workbooks with file inputs in the extension popup, then selects the product
folder in the existing panel.

## Extension architecture

Add a popup and the SheetJS workbook reader already used by the user's existing
`shopee_helper_v1_2_2` extension. The popup parses both workbooks and stores only
the normalized maps plus metadata in `chrome.storage.local`; the content script
reloads these maps when they change.

The content script remains responsible for page-specific work: reading the listing
ID from the URL, constructing a preflight plan, manipulating Shopee fields, and
showing progress. `storage` is added to the manifest; no network permission is
added.

## Data parsing

### Listing map

The parser finds the header row by column labels and converts the listing ID to a
canonical integer string. A record is valid only when it has a listing ID, title,
and article body. Variation cells are parsed from this format:

`«Group name»: value 1 · value 2`

One or two group cells are allowed. `—` and blank cells mean no group. Group names
are rendered on Shopee after removing whitespace only. Values retain their original
spacing and display text.

### SKU candidates

For each variation combination, the extension derives normalized matching tokens
from the displayed values and scores rows in the Doris product-name index. Matching
normalizes accents, case, punctuation, multiplication signs, and the gift notation
(`🎁100` is comparable to `1 x 100ml`). The current listing title contributes
product-family tokens as a tie-breaker.

Only a unique highest-scoring candidate is accepted. No candidate or a tie is a
preflight error for that row: its SKU is not filled and the panel names the failed
combination. The extension never guesses an arbitrary SKU.

## Run sequence

1. Preflight: require loaded workbooks, a listing ID match, valid naming, every
   required variation image, no SKU ambiguity, and image counts within Shopee
   limits. Show the resolved plan before enabling Run.
2. Replace the square and 3:4 product images with cover + `g1..gN`, preserving
   the current upload/crop flow.
3. Set the product title using the native input setter and `input`/`change` events.
4. Split `Bài Đăng` at its first newline. Replace the description with the first
   line, upload `g2..gN` into the rich-text editor in order, wait for the images to
   finish, then append the remaining paragraphs. Text is escaped before it reaches
   editor HTML.
5. Create or fill one/two variation groups and their option values. After Shopee
   renders the variation matrix, associate each row with its displayed option pair.
6. Upload variation-1 images from the selected folder. Fill an SKU only for a
   unique resolved Doris candidate. Set stock to `100` only when that row's stock
   input is blank; never overwrite an existing stock value.
7. Report a complete or partial result. Do not click the page-level `Lưu` or
   `Cập nhật` button.

## Failure behavior

The run stops before destructive image replacement when preflight fails. Runtime
errors preserve completed page changes and identify the failed stage. A cancel
request stops at the next safe wait boundary. Missing/ambiguous SKU and missing
variation images are fail-closed conditions.

## Tests and verification

Extract pure helpers for listing-ID parsing, variation-cell parsing, filename slug
matching, text escaping, and SKU candidate scoring. Cover them with Node tests,
including the known mapping `Sả Chanh` + `2×500ml +🎁100` to `ATDSC500X2Q100`.
Verify syntax, manifest references, tests, and a manual Shopee test with the
provided listing folder. Runtime DOM selectors remain a manual integration check
because Shopee owns the rendered UI.
