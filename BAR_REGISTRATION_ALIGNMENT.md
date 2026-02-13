# Backend Alignment - Bar Registration System

## 🔧 Modifiche Implementate

### 1. **barValidator.ts** - Allineamento dei nomi dei campi
- **Prima:** `iva`, `merchantName`, `name`, `address`, `image`
- **Dopo:** `piva`, `barName`, `businessName`, `address`, `coverImageUrl`
- **Validazione P.IVA:** Regex per esattamente 11 cifre numeriche
- Questo allinea il validator ai nomi che il frontend invia

### 2. **imageUpload.ts** (NUOVO)
Utility per gestire il salvataggio e l'ottimizzazione delle immagini:

**Funzioni:**
- `saveAndOptimizeImage()` - Salva e ottimizza PNG con sharp
  - Resize max 1200px larghezza
  - Compress a quality 80
  - Salva in `/uploads/bars/`
  - Ritorna URL accessibile: `/uploads/bars/{timestamp}-{filename.png}`

- `isPngFile()` - Valida che il file sia PNG
- `isFileSizeValid()` - Valida dimensione max 5MB

**Storage:**
- Development: Filesystem locale in `/uploads/bars/`
- Production: Ready for cloud storage (S3, Cloudinary, ecc)

### 3. **barController.ts** - Gestione multipart/form-data
**Cambiamenti:**
- Aggiunto import di `saveAndOptimizeImage`, `isPngFile`, `isFileSizeValid`
- Aggiunto import di `MultipartFile` type
- Refactor completo di `register()` per:
  1. Leggere i dati dal multipart form-data
  2. Separate campi testo da file
  3. Validare il file (PNG, max 5MB)
  4. Validare i campi con Zod
  5. Verificare P.IVA non duplicata
  6. Verificare user non ha bar già registrato
  7. Salvare e ottimizzare immagine
  8. Salvare dati nel DB
  9. Ritornare risposta con nomi camelCase allineati al frontend

- Refactor di `getBarByUser()` per:
  1. Mappare i nomi dal database al frontend
  2. Database: `iva`, `merchant_name`, `name`, `image`
  3. Response: `piva`, `businessName`, `barName`, `coverImage`

**Response (POST /api/bar/registration):**
```json
{
  "success": true,
  "message": "Bar registrato con successo",
  "data": {
    "id": 123,
    "userId": 456,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/1708018200000-bar_cover_1707941234.png"
  }
}
```

**Response (GET /api/bar/profile):**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/1708018200000-bar_cover_1707941234.png",
    "createdAt": "2025-02-14T10:30:00Z",
    "updatedAt": "2025-02-14T10:30:00Z"
  }
}
```

### 4. **barRepository.ts** - Allineamento parametri
- Changed `createBar()` signature: `iva` → `piva`
- Aggiunto metodo `pivaExists()` (nuovo nome)
- Mantenuto `ivaExists()` come alias per backward compatibility
- Nomi colonne database rimangono unchanged: `iva`, `merchant_name`, `name`, `image`

### 5. **package.json** - Nuova dipendenza
```json
"@fastify/static": "^7.0.0"
```
Per servire i file statici dalla cartella `/uploads`

### 6. **index.ts** - Configurazione server
- Importato `@fastify/static`
- Importato `path` e `fileURLToPath` per path resolution
- Registrato staticPlugin per servire `/uploads` directory
- Files sono accessibili via: `http://server:port/uploads/bars/{filename}`

### 7. **.gitignore** - Esclusione uploads
```
# uploads
uploads/
```
La cartella uploads non viene committata in git

---

## 📊 Mapping Frontend → Backend → Database

```
FRONTEND (request)          BACKEND (validator)     DATABASE (storage)
├─ piva                     ├─ piva                 └─ iva
├─ barName                  ├─ barName              └─ name
├─ businessName             ├─ businessName         └─ merchant_name
├─ address                  ├─ address              └─ address
└─ coverImage (FILE)        └─ coverImageUrl (URL)  └─ image
```

---

## 🔄 Flusso Completo (Aligned)

### Request Flow:
```
1. Frontend sends POST /api/bar/registration (multipart/form-data)
   └─ piva, barName, businessName, address, coverImage (file)

2. Backend barController.register():
   ├─ Parses multipart form-data
   ├─ Validates file (PNG, max 5MB)
   ├─ Validates fields with Zod
   ├─ Saves image with imageUpload utility
   ├─ Saves to DB with barRepository
   └─ Returns response with camelCase names

3. Frontend receives response:
   └─ Maps to BarSuccessScreen data
```

### Get Profile Flow:
```
1. Frontend sends GET /api/bar/profile (with Bearer token)

2. Backend barController.getBarByUser():
   ├─ Extracts userId from token
   ├─ Queries DB for bar
   ├─ Maps DB field names to frontend field names
   └─ Returns response with camelCase names

3. Frontend receives response:
   └─ Displays in HomeScreen or BarProfileScreen
```

---

## ✅ Testing Checklist

### POST /api/bar/registration
- [ ] Valid form with PNG file → 200 OK
- [ ] Duplicate P.IVA → 409 Conflict
- [ ] Missing field → 400 Bad Request
- [ ] Invalid file type (not PNG) → 400 Bad Request
- [ ] File too large (> 5MB) → 400 Bad Request
- [ ] User already has bar → 409 Conflict
- [ ] Invalid token → 401 Unauthorized
- [ ] Image is properly saved and optimized

### GET /api/bar/profile
- [ ] Authorized user with bar → 200 OK with correct field names
- [ ] Authorized user without bar → 404 Not Found
- [ ] Invalid token → 401 Unauthorized

---

## 🚀 Deployment Notes

### File Storage:
**Development:** Local filesystem at `/uploads/bars/`  
**Production:** Should switch to cloud storage (AWS S3, Cloudinary, Firebase Storage, etc.)

To migrate to cloud storage:
1. Update `saveAndOptimizeImage()` in `src/utils/imageUpload.ts`
2. Return cloud storage URL instead of local path
3. Remove @fastify/static registration from index.ts

### Database Schema:
- Table `bars` should have columns:
  - `iva VARCHAR(11) UNIQUE NOT NULL`
  - `merchant_name VARCHAR(255)`
  - `name VARCHAR(255)`
  - `address VARCHAR(500)`
  - `image TEXT` (stores URL)

---

## 📝 Files Modified

✅ `src/validators/barValidator.ts` - Field name alignment  
✅ `src/utils/imageUpload.ts` - NEW file for image handling  
✅ `src/controllers/barController.ts` - Multipart form parsing & response mapping  
✅ `src/repositories/barRepository.ts` - Parameter alignment  
✅ `package.json` - Added @fastify/static  
✅ `src/index.ts` - Static file serving configuration  
✅ `.gitignore` - Added uploads/ directory  

---

## 🔗 Frontend Compatibility

Frontend expects:
- Response field names: `piva`, `barName`, `businessName`, `address`, `coverImage`
- Image URL format: fully qualified or relative path
- Status codes: 200, 400, 404, 409, 401, 500

✅ All aligned correctly
