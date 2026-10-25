Turbo80 v1.4 — the ZX Spectrum emulator, for your website
=================================================================

This folder is the whole emulator (13 machines, tapes, disks, assembler,
debugger, settings…) ready to be hosted on your own website, without
depending on turbo80.com. It does not include the game Library or online
play, which need the turbo80.com server.

HOW TO USE IT

1. Upload this folder (turbo80/) to your site, next to your page. It has to
   be served over HTTP, like any website; nothing special is needed.

2. In your page, a div, the script and one call:

     <div id="spectrum"></div>
     <script src="turbo80/turbo80.js"></script>
     <script>Turbo80(document.getElementById('spectrum'), { load: 'game.tap' });</script>

   Or without JavaScript:  <div data-turbo80="game.tap" data-model="128k"></div>

3. You can also open turbo80/index.html as it is: it is the full emulator.

Options, methods and events are in the guide:
  https://turbo80.com/embed     (English)
  https://turbo80.com/embeber   (Spanish)
And the examples/ and ejemplos/ folders hold minimal pages, with the HTML
that produces them, ready to copy.

For files from other domains that do not allow CORS, the loader uses the
turbo80.com relay; relay: false disables it.

LICENSES

The Spectrum ROMs (16K/48K/128K/+2/+2A/+3) are included with the permission
of Amstrad, which allows their use with emulators. The Timex ROMs are
Sinclair's with changes by Timex, and those changes are in the public domain.
The Interface 1 ROM is © 1983 Sinclair Research Ltd and is unmodified.
The +D disk interface ROM (by Miles Gordon Technology) is included with the
permission of Datel, its rights holder; its system, G+DOS, is not included.
esxDOS 0.8.9 (the DivMMC's ROM and SD card, © 2005-2021 Papaya Dezign and
the contributors to its package, credited in the card's README.TXT) is
included with Papaya Dezign's permission. The TR-DOS and Scorpion ROMs are not
included; the emulator accepts them as user files.
