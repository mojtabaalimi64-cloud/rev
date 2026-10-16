# REV Mobile Prototype

This directory contains an isolated mobile-first prototype. It links to existing REV pages and does not replace the desktop website or admin panel.

## Included
- Responsive Persian RTL app shell and mobile bottom navigation.
- Links to existing trip planning, checklist, services, driver profile, learning, news, and account pages.
- A manifest and service worker scoped to this directory.
- No API response or private data is cached for offline use.
- No secret API keys or fabricated service/analytics data.

## Release status
This prototype is still stored in the website repository. A separate app repository/hosting project and independent deployment workflow have **not** been configured yet, so full release isolation is not complete. These changes are on an experimental branch and have not been deployed to the live site.

## Manual checks after preview hosting
1. Check widths around 360, 390, and 430 px and verify there is no horizontal overflow.
2. Check that the bottom navigation does not cover page content.
3. Open every link and verify it reaches the existing REV page.
4. Test PWA installation only over HTTPS.
5. Smoke-test the website, admin, and APIs separately.
6. Configure separate app hosting and deployment before any public release.

## Next step
After reviewing the look and navigation, move this app into its own repository or hosting project and configure a separate preview/release workflow. No production website files have been changed.