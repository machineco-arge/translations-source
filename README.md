# @machineco-arge/translations-source

Bu repo, Machine Co. Arge projeleri için merkezi çeviri yönetim sistemidir. Platformdaki tüm uygulamalar için "tek doğru kaynak" (Single Source of Truth) olarak hizmet verir.

Bu sistemin iki ana çıktısı vardır:
1.  **Canlı Çeviri CDN'i:** Desteklenen tüm dillere çevrilmiş `json` dosyaları, bu reponun GitHub Pages sitesinde barındırılır. Uygulamalar, en güncel çevirileri bu CDN'den dinamik olarak çeker.
2.  **Geliştirme Paketi:** Ana dildeki (`tr`) çeviri anahtarlarını içeren (`/source` klasörü) ve diğer projelere bir `devDependency` olarak eklenen bir NPM paketi yayınlar. Bu, geliştirme sırasında anahtar tutarlılığı ve IDE'de otomatik tamamlama sağlar.

---

## 🚀 Otomasyon (CI/CD)

Bu repo, tam otomatik bir iş akışına sahiptir. `source/` dizinindeki dosyalarda bir değişiklik yapılıp `main` branch'ine push'landığında, GitHub Actions otomatik olarak şu adımları gerçekleştirir:
1.  Tüm kaynak metinleri desteklenen dillere çevirir ve `dist/` klasörünü oluşturur.
2.  `dist/` klasörünü GitHub Pages'e dağıtarak CDN'i günceller.
3.  `package.json` dosyasındaki versiyonu artırır (patch).
4.  Yeni versiyonlu `@machineco-arge/translations-source` paketini GitHub Packages'e yayınlar.
5.  Versiyon değişikliğini ve etiketi (tag) repoya geri push'lar.

---

## 🛠️ İş Akışı ve Kullanım

### Yeni Bir Çeviri Anahtarı Ekleme/Değiştirme

Tek yapmanız gereken, `/source` klasöründeki ilgili `json` dosyasını düzenlemek ve değişikliği `main` branch'ine push'lamaktır.

**Örnek:** `PhotoApp`'e yeni bir "Raporu İndir" butonu eklemek.

1.  `source/photo-app.json` dosyasını açın.
2.  Yeni anahtar-değer çiftini ekleyin:
    ```json
    {
      "downloadReportButton": "Raporu İndir"
    }
    ```
3.  Değişikliklerinizi commit'leyip push'layın:
    ```bash
    git add source/photo-app.json
    git commit -m "feat(photo-app): add downloadReportButton translation"
    git push origin main
    ```

Otomasyon gerisini halledecektir. Manuel olarak versiyon yükseltmeye, paket yayınlamaya veya `dist` klasörünü commit'lemeye **gerek yoktur.**

---

##  consuming-apps Tüketici Uygulamalarda Kurulum

`PhotoApp` gibi bir projenin bu paketi ve CDN'i kullanabilmesi için:

### 1. Projenizi GitHub Packages'e Bağlayın

Projenizin kök dizininde bir `.npmrc` dosyası oluşturun veya mevcut dosyayı düzenleyin. Bu dosya, `@machineco-arge` kapsamındaki paketleri nereden indireceğini `npm`'e bildirir.

```
# .npmrc
@machineco-arge:registry=https://npm.pkg.github.com
```

### 2. GitHub'da Kimlik Doğrulayın

GitHub Packages'ten özel paket indirebilmek için `read:packages` iznine sahip bir Personal Access Token (PAT) oluşturmanız ve yerel `npm`'inizde bu token ile giriş yapmanız gerekir.

Bu işlemi sadece bir kez yapmanız yeterlidir:
```bash
npm login --scope=@machineco-arge --registry=https://npm.pkg.github.com
```
Sizden kullanıcı adı (GitHub kullanıcı adınız), şifre (oluşturduğunuz PAT) ve e-posta istenecektir.

### 3. Geliştirme Paketini Kurun

Çeviri anahtarlarını geliştirme ortamında kullanabilmek için paketi bir `devDependency` olarak ekleyin:
```bash
npm install @machineco-arge/translations-source --save-dev
```

### 4. `i18next`'i Yapılandırın

Uygulamanızın `i18n` yapılandırmasında, `i18next-http-backend` kullanarak çevirileri doğrudan GitHub Pages CDN'inden çekecek şekilde ayarlayın.

**Örnek CDN URL yapısı:** `https://machineco-arge.github.io/translations-source/{{ns}}/{{lng}}.json`

```typescript
import i18next from 'i18next';
import HttpApi from 'i18next-http-backend';

const appName = 'photo-app'; // Bu, uygulamaya özel namespace'dir.
const cdnUrl = 'https://machineco-arge.github.io/translations-source';

i18next
  .use(HttpApi)
  .init({
    lng: 'tr',
    fallbackLng: 'tr',
    ns: ['login', appName], // Yüklenecek namespace'ler: ortak + uygulamaya özel
    defaultNS: appName,
    backend: {
      loadPath: `${cdnUrl}/{{ns}}/{{lng}}.json`
    },
    // ...diğer i18next ayarları
  });
```
Artık uygulamanız her zaman en güncel çevirilere sahip olacak. 