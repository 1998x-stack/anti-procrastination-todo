# Shared security headers for every response of the static Start-First site.
# Included from each location so that location-level add_header does not
# accidentally drop the security headers (nginx does not inherit add_header
# from a parent level once a child level defines its own).
#
# The app is a dependency-free ES-module static site: no inline scripts,
# no inline styles, no third-party requests, no fetch/XHR/sendBeacon.
# The policy below is therefore 'self'-only and deliberately strict.

add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'none'; manifest-src 'self'" always;
# Filenames are not content-hashed in this no-build project, so every response
# must be revalidated. This prevents a deploy from mixing two versions.
add_header Cache-Control "no-cache" always;
