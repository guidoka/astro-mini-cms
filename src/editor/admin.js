// astro-mini-cms, Client-Seite: Rich-Text (TinyMCE, selbst gehostet),
// Bildauswahl, Raster-Editor mit Zeilen, Spalten und Blöcken. Kein Framework,
// damit es ohne Build läuft. Wird von components/Scripts.astro inline
// eingebettet und läuft im <head>; die Felder sucht es erst, wenn das
// Dokument steht (DOMContentLoaded).
//
// Blocktypen: Text, Bild und Bildergalerie sind eingebaut. Ein Projekt
// registriert eigene vor DOMContentLoaded:
//
//   window.miniCms.registerBlock('courses', {
//     label: 'Kurskacheln', order: 50,
//     create: function () { return { type: 'courses', course_ids: [], heading: '' }; },
//     render: function (body, block, ctx) { … }
//   });
//
// ctx: render (Editor neu zeichnen), bindTiny(textarea, obj, key, height),
//      pickImage(cb), esc(text), handle(payload, title), dropZone(el, kind, cb),
//      moveTo(list, from, to), confirm(text, opts), alert(text).
//
// TinyMCE-Einstellungen des Projekts (etwa content_css mit dem Theme der
// Seite) ueber window.miniCms.tinyOptions = { … }; sie werden beim Start
// jedes Editors ueber die Vorgaben gelegt. Fuer eigene Listen mit Ziehen
// stehen handle, dropZone und moveTo auch in window.miniCms.
(function () {
  'use strict';

  // Dialoge stellt die Pflegeoberfläche (AdminShell); ohne sie die des Browsers.
  function confirmFn(msg, opts) {
    return window.cmsConfirm ? window.cmsConfirm(msg, opts) : Promise.resolve(window.confirm(msg));
  }
  function alertFn(msg) {
    if (window.cmsAlert) return window.cmsAlert(msg);
    window.alert(msg);
    return Promise.resolve(true);
  }

  // ---- TinyMCE ------------------------------------------------------------
  var TINY = {
    base_url: '/vendor/tinymce', suffix: '.min', promotion: false, branding: false,
    menubar: false, height: 360,
    plugins: 'link lists table anchor code image',
    toolbar: 'undo redo | blocks | bold italic | alignleft aligncenter alignright | bullist numlist | link anchor image table | code',
    block_formats: 'Absatz=p; Titel 2=h2; Titel 3=h3; Titel 4=h4',
    // Inhalte sollen unverändert durch den Editor gehen.
    valid_elements: '*[*]', extended_valid_elements: '*[*]', verify_html: false,
    convert_urls: false, relative_urls: false, remove_script_host: false, entity_encoding: 'raw',
    content_style: 'body{padding:12px;font-size:16px;font-family:system-ui,"Segoe UI",sans-serif;line-height:1.6}',
    file_picker_types: 'image',
    file_picker_callback: function (cb) { pickImage(function (f) { cb(f.src, { alt: f.title || '' }); }); }
  };
  function initTiny(el) {
    if (!window.tinymce || !el || el.dataset.tinyReady) return;
    el.dataset.tinyReady = '1';
    var extra = (window.miniCms && window.miniCms.tinyOptions) || {};
    window.tinymce.init(Object.assign({ target: el }, TINY, extra, el.dataset.tinyHeight ? { height: +el.dataset.tinyHeight } : {}));
  }
  function initAllTiny() { document.querySelectorAll('textarea.tinymce').forEach(initTiny); }

  // ---- Bildauswahl --------------------------------------------------------
  var picker;
  function pickImage(onPick) {
    if (!picker) {
      picker = document.createElement('div');
      picker.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center">' +
        '<div style="background:#fff;border-radius:8px;width:min(60rem,95vw);max-height:90vh;display:flex;flex-direction:column">' +
        '<div style="display:flex;gap:.5rem;padding:.75rem;border-bottom:1px solid #e7e5e4;align-items:center">' +
        '<input data-q placeholder="Suchen…" style="flex:1;padding:.4rem .6rem;border:1px solid #d6d3d1;border-radius:4px">' +
        '<select data-folder style="padding:.4rem .6rem;border:1px solid #d6d3d1;border-radius:4px"><option value="">alle Ordner</option></select>' +
        '<label class="btn secondary" style="margin:0">Hochladen <input data-up type="file" accept="image/*,.pdf" style="display:none"></label>' +
        '<button type="button" data-close class="btn secondary">Schliessen</button></div>' +
        '<div data-grid style="overflow:auto;padding:.75rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));grid-auto-rows:max-content;align-content:start;gap:.5rem"></div></div></div>';
      document.body.appendChild(picker);
      picker.querySelector('[data-close]').onclick = function () { picker.style.display = 'none'; };
      picker.querySelector('[data-q]').oninput = debounce(function () { load(); }, 250);
      picker.querySelector('[data-folder]').onchange = function () { load(); };
      picker.querySelector('[data-up]').onchange = function (e) {
        var fd = new FormData(); fd.append('file', e.target.files[0]);
        fetch('/admin/api/upload', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (f) {
          if (f.error) { alertFn(f.error); return; }
          picker.onPick(f); picker.style.display = 'none';
        });
        e.target.value = '';
      };
    }
    picker.onPick = onPick;
    picker.style.display = '';
    load();
    function load() {
      var q = picker.querySelector('[data-q]').value;
      var sel = picker.querySelector('[data-folder]');
      fetch('/admin/api/dateien?q=' + encodeURIComponent(q) + '&ordner=' + encodeURIComponent(sel.value)).then(function (r) { return r.json(); }).then(function (data) {
        var files = data.files || [];
        // Ordnerliste einmal füllen, die Auswahl bleibt beim Neuladen stehen.
        if (sel.options.length <= 1 && data.folders) {
          data.folders.forEach(function (o) {
            if (!o.name) return;
            var opt = document.createElement('option'); opt.value = o.name; opt.textContent = o.name + ' (' + o.n + ')';
            sel.appendChild(opt);
          });
        }
        var grid = picker.querySelector('[data-grid]'); grid.innerHTML = '';
        if (!files.length) {
          grid.innerHTML = '<p style="grid-column:1/-1;color:#57534e;font-size:.85rem">Keine Dateien. Oben lässt sich eine hochladen.</p>';
          return;
        }
        if (data.total > files.length) {
          grid.innerHTML = '<p style="grid-column:1/-1;color:#57534e;font-size:.85rem;margin:0">' + files.length + ' von ' + data.total + ' Dateien. Über Suche oder Ordner eingrenzen.</p>';
        }
        files.forEach(function (f) {
          var b = document.createElement('button'); b.type = 'button';
          b.style.cssText = 'border:1px solid #e7e5e4;border-radius:4px;background:#fff;padding:.25rem;cursor:pointer;text-align:center;font-size:.7rem;overflow:hidden';
          var isImg = (f.mime || '').indexOf('image/') === 0;
          b.innerHTML = (isImg ? '<img src="' + f.src + '" style="display:block;width:100%;aspect-ratio:4/3;object-fit:contain">' : '<div style="aspect-ratio:4/3;display:grid;place-items:center">PDF</div>') +
            '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(f.filename) + '</div>';
          b.onclick = function () { picker.onPick(f); picker.style.display = 'none'; };
          grid.appendChild(b);
        });
      });
    }
  }

  // Bildfeld ausserhalb des Rasters: [data-image-field]
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-pick-image]');
    if (btn) {
      var field = btn.closest('[data-image-field]');
      pickImage(function (f) {
        field.querySelector('input[type=hidden]').value = f.id;
        var img = field.querySelector('img'); img.src = f.src; img.style.display = '';
        field.querySelector('[data-filename]').textContent = f.filename;
      });
    }
    var clr = e.target.closest('[data-clear-image]');
    if (clr) {
      var f2 = clr.closest('[data-image-field]');
      f2.querySelector('input[type=hidden]').value = '';
      f2.querySelector('img').style.display = 'none';
      f2.querySelector('[data-filename]').textContent = 'kein Bild';
    }
  });

  // ---- Ziehen und Ablegen -------------------------------------------------
  // Nur der Griff ist ziehbar, damit TinyMCE und Eingabefelder nicht
  // mitgezogen werden. Die Nutzlast liegt in drag, weil dataTransfer während
  // dragover nicht lesbar ist.
  var drag = null;
  function handle(payload, title) {
    var h = document.createElement('span');
    h.textContent = '⣿'; h.title = title || 'Ziehen zum Verschieben'; h.draggable = true;
    h.style.cssText = 'cursor:grab;user-select:none;padding:0 .35rem;color:#a8a29e;font-size:1rem;line-height:1';
    h.addEventListener('dragstart', function (e) { drag = payload; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); });
    h.addEventListener('dragend', function () { drag = null; document.querySelectorAll('.drop-over').forEach(function (el) { el.classList.remove('drop-over'); }); });
    return h;
  }
  function dropZone(el, kind, onDrop) {
    el.addEventListener('dragover', function (e) { if (drag && drag.kind === kind) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-over'); } });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-over'); });
    el.addEventListener('drop', function (e) {
      if (!drag || drag.kind !== kind) return;
      e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-over');
      var d = drag; drag = null; onDrop(d);
    });
  }
  function moveTo(list, from, to) { var item = list.splice(from, 1)[0]; list.splice(to, 0, item); }

  // ---- Blocktypen ---------------------------------------------------------
  var DEFAULT_LAYOUTS = {
    voll: [12], halbe_halbe: [6, 6], drittel: [4, 4, 4], viertel: [3, 3, 3, 3],
    zweidrittel_rest: [8, 4], eindrittel_rest: [4, 8]
  };
  var blocks = {};
  function registerBlock(type, def) {
    blocks[type] = Object.assign({ label: type, order: 50 }, def);
  }
  function blockTypes() {
    return Object.keys(blocks).sort(function (a, b) { return blocks[a].order - blocks[b].order; });
  }

  registerBlock('rte', {
    label: 'Text', order: 10,
    create: function () { return { type: 'rte', html: '<p></p>' }; },
    render: function (body, b, ctx) { body.appendChild(ctx.bindTiny(document.createElement('textarea'), b, 'html')); }
  });

  registerBlock('image', {
    label: 'Bild', order: 20,
    create: function () { return { type: 'image', file_id: null, src: '', alt: '' }; },
    render: function (body, b) {
      body.innerHTML = '<div data-image-field style="display:flex;gap:.5rem;align-items:center"><input type="hidden" value="' + (b.file_id || '') + '">' +
        '<img src="' + esc(b.src || '') + '" style="height:64px;max-width:120px;object-fit:contain;' + (b.src ? '' : 'display:none') + '">' +
        '<div style="flex:1;min-width:0"><div data-filename style="font-size:.75rem;overflow:hidden;text-overflow:ellipsis">' + esc(b.src ? b.src.split('/').pop() : 'kein Bild') + '</div>' +
        '<input type="text" placeholder="Alternativtext: beschreibt das Bild in Worten, wichtig für Suchmaschinen und Vorlesen" value="' + esc(b.alt || '') + '" data-alt style="margin-top:.25rem"></div>' +
        '<button type="button" class="btn secondary" data-pick-image>Bild wählen</button></div>';
      var hid = body.querySelector('input[type=hidden]');
      var img = body.querySelector('img');
      // Die Auswahl schreibt ins versteckte Feld und ins Bild; von dort zurück in den Block.
      body.querySelector('[data-pick-image]').addEventListener('click', function () {
        var o = new MutationObserver(function () { b.file_id = hid.value || null; b.src = img.getAttribute('src') || ''; o.disconnect(); });
        o.observe(img, { attributes: true, attributeFilter: ['src'] });
      });
      body.querySelector('[data-alt]').addEventListener('input', function (e) { b.alt = e.target.value; });
    }
  });

  registerBlock('slider', {
    label: 'Bildergalerie', order: 90,
    create: function () { return { type: 'slider', items: [] }; },
    render: function (body, b, ctx) {
      if (!b.items) b.items = [];
      var hint = document.createElement('div'); hint.style.cssText = 'font-size:.8rem;color:#57534e;margin-bottom:.4rem';
      hint.textContent = b.items.length ? 'Die Bilder laufen als Galerie durch. Reihenfolge per Griff oder Pfeilen.' : 'Noch keine Bilder. Mit „+ Bild zur Galerie“ beginnen.';
      body.appendChild(hint);
      b.items.forEach(function (it, ii) { body.appendChild(renderSlide(b, it, ii, ctx)); });
      var addS = document.createElement('button'); addS.type = 'button'; addS.className = 'btn secondary'; addS.style.fontSize = '.75rem'; addS.textContent = '+ Bild zur Galerie';
      addS.onclick = function () { ctx.pickImage(function (f) { b.items.push({ file_id: f.id, src: f.src, title: f.title || '', html: '' }); ctx.render(); }); };
      body.appendChild(addS);
    }
  });

  function renderSlide(b, it, ii, ctx) {
    var w = document.createElement('div');
    w.style.cssText = 'display:flex;gap:.5rem;align-items:flex-start;border:1px solid #e7e5e4;border-radius:4px;padding:.4rem;margin-bottom:.4rem;background:#fff';
    w.appendChild(ctx.handle({ kind: 'slide', items: b.items, i: ii }, 'Bild verschieben'));
    var left = document.createElement('div'); left.style.cssText = 'display:flex;flex-direction:column;gap:.25rem;align-items:center;width:130px;flex:none';
    left.innerHTML = '<img src="' + esc(it.src || '') + '" style="width:120px;height:80px;object-fit:contain;border:1px solid #e7e5e4;background:#fafaf9">' +
      '<button type="button" class="btn secondary" style="font-size:.7rem;padding:.15rem .4rem" data-swap>Bild wechseln</button>';
    left.querySelector('[data-swap]').onclick = function () {
      ctx.pickImage(function (f) { it.file_id = f.id; it.src = f.src; if (!it.title) it.title = f.title || ''; ctx.render(); });
    };
    var right = document.createElement('div'); right.style.cssText = 'flex:1;min-width:0';
    var t = document.createElement('input'); t.type = 'text'; t.value = it.title || ''; t.placeholder = 'Bildtitel (dient als Alternativtext)'; t.style.marginBottom = '.25rem';
    t.addEventListener('input', function () { it.title = t.value; });
    right.appendChild(t);
    right.appendChild(ctx.bindTiny(document.createElement('textarea'), it, 'html', 160));
    var side = document.createElement('div'); side.style.cssText = 'display:flex;flex-direction:column;gap:.25rem';
    side.innerHTML = '<button type="button" class="btn secondary" style="padding:.1rem .4rem" data-sup title="nach oben">↑</button>' +
      '<button type="button" class="btn secondary" style="padding:.1rem .4rem" data-sdown title="nach unten">↓</button>' +
      '<button type="button" class="btn danger" style="padding:.1rem .4rem" data-sdel title="aus der Galerie entfernen">×</button>';
    side.querySelector('[data-sup]').onclick = function () { if (ii > 0) { ctx.moveTo(b.items, ii, ii - 1); ctx.render(); } };
    side.querySelector('[data-sdown]').onclick = function () { if (ii < b.items.length - 1) { ctx.moveTo(b.items, ii, ii + 1); ctx.render(); } };
    side.querySelector('[data-sdel]').onclick = function () {
      ctx.confirm('Bild aus der Galerie entfernen? Die Datei selbst bleibt erhalten.', { ok: 'Ja, entfernen' })
        .then(function (yes) { if (yes) { b.items.splice(ii, 1); ctx.render(); } });
    };
    w.appendChild(left); w.appendChild(right); w.appendChild(side);
    ctx.dropZone(w, 'slide', function (d) { if (d.items === b.items && d.i !== ii) { ctx.moveTo(b.items, d.i, ii); ctx.render(); } });
    return w;
  }

  // ---- Raster-Editor ------------------------------------------------------
  function initLayoutEditor(root) {
    var config = {};
    try { config = JSON.parse(root.dataset.config || '{}'); } catch (e) { config = {}; }
    var LAYOUTS = config.layouts || DEFAULT_LAYOUTS;
    var NAMES = config.names || {};
    var input = root.querySelector('input[name=layout]');
    var state; try { state = JSON.parse(input.value || '{"rows":[]}'); } catch (e) { state = { rows: [] }; }
    if (!state.rows) state.rows = [];
    var host = root.querySelector('[data-rows]');
    var ctx = {
      render: render, bindTiny: bindTiny, pickImage: pickImage, esc: esc,
      handle: handle, dropZone: dropZone, moveTo: moveTo, confirm: confirmFn, alert: alertFn
    };

    function render() {
      collect(); // Inhalte sichern, bevor das DOM neu entsteht
      if (window.tinymce) window.tinymce.remove('#' + root.id + ' textarea.tinymce');
      host.innerHTML = '';
      if (!state.rows.length) {
        host.innerHTML = '<p style="font-size:.85rem;color:#57534e">Noch keine Zeile. Unten eine hinzufügen.</p>';
      }
      state.rows.forEach(function (row, ri) {
        var r = document.createElement('div');
        r.className = 'card'; r.style.marginBottom = '.75rem'; r.style.padding = '.75rem';
        var head = document.createElement('div'); head.style.cssText = 'display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem';
        head.appendChild(handle({ kind: 'row', ri: ri }, 'Zeile verschieben'));
        var headRest = document.createElement('div'); headRest.style.cssText = 'display:flex;gap:.5rem;align-items:center;flex:1';
        headRest.innerHTML = '<strong style="font-size:.8rem">Zeile ' + (ri + 1) + '</strong>' +
          '<select data-layout style="width:auto">' + Object.keys(LAYOUTS).map(function (k) { return '<option value="' + k + '"' + (k === row.layout ? ' selected' : '') + '>' + esc(NAMES[k] || k) + '</option>'; }).join('') + '</select>' +
          '<span style="flex:1"></span>' +
          '<button type="button" class="btn secondary" data-up title="nach oben">↑</button>' +
          '<button type="button" class="btn secondary" data-down title="nach unten">↓</button>' +
          '<button type="button" class="btn danger" data-del>Zeile löschen</button>';
        head.appendChild(headRest);
        head.querySelector('[data-layout]').onchange = function (e) { setLayout(row, e.target.value); render(); };
        head.querySelector('[data-up]').onclick = function () { if (ri > 0) { moveTo(state.rows, ri, ri - 1); render(); } };
        head.querySelector('[data-down]').onclick = function () { if (ri < state.rows.length - 1) { moveTo(state.rows, ri, ri + 1); render(); } };
        head.querySelector('[data-del]').onclick = function () {
          confirmFn('Zeile ' + (ri + 1) + ' mit allen Blöcken löschen?').then(function (yes) { if (yes) { state.rows.splice(ri, 1); render(); } });
        };
        r.appendChild(head);
        dropZone(r, 'row', function (d) { if (d.ri !== ri) { moveTo(state.rows, d.ri, ri); render(); } });

        var cols = document.createElement('div');
        cols.style.cssText = 'display:grid;gap:.5rem;grid-template-columns:' + row.columns.map(function (c) { return c.span + 'fr'; }).join(' ');
        row.columns.forEach(function (col, ci) {
          var c = document.createElement('div'); c.style.cssText = 'border:1px dashed #d6d3d1;border-radius:4px;padding:.5rem;min-width:0';
          c.innerHTML = '<div style="font-size:.7rem;color:#78716c;margin-bottom:.25rem">Spalte ' + (ci + 1) + ' · ' + col.span + '/12</div>';
          col.blocks.forEach(function (b, bi) { c.appendChild(renderBlock(col, b, bi)); });
          var add = document.createElement('div'); add.style.cssText = 'display:flex;gap:.25rem;flex-wrap:wrap;margin-top:.25rem';
          blockTypes().forEach(function (t) {
            var bt = document.createElement('button'); bt.type = 'button'; bt.className = 'btn secondary'; bt.style.fontSize = '.75rem'; bt.textContent = '+ ' + blocks[t].label;
            bt.onclick = function () { col.blocks.push(blocks[t].create()); render(); };
            add.appendChild(bt);
          });
          c.appendChild(add);
          dropZone(c, 'block', function (d) { var item = d.col.blocks.splice(d.bi, 1)[0]; col.blocks.push(item); render(); });
          cols.appendChild(c);
        });
        r.appendChild(cols);
        host.appendChild(r);
      });
      initAllTiny();
    }

    function bindTiny(ta, obj, key, height) {
      ta.className = 'tinymce'; ta.value = obj[key] || ''; ta.id = 'ta_' + Math.random().toString(36).slice(2);
      if (height) ta.dataset.tinyHeight = String(height);
      ta._bind = { obj: obj, key: key };
      ta.addEventListener('change', function () { obj[key] = ta.value; });
      return ta;
    }

    function renderBlock(col, b, bi) {
      var def = blocks[b.type];
      var label = def ? def.label : b.type;
      var w = document.createElement('div');
      w.style.cssText = 'border:1px solid #e7e5e4;border-radius:4px;padding:.4rem;margin-bottom:.4rem;background:#fafaf9';
      var bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:.25rem;align-items:center;font-size:.72rem;color:#57534e;margin-bottom:.25rem';
      bar.appendChild(handle({ kind: 'block', col: col, bi: bi }, 'Block verschieben, auch in eine andere Spalte'));
      var barRest = document.createElement('div'); barRest.style.cssText = 'display:flex;gap:.25rem;align-items:center;flex:1';
      barRest.innerHTML = '<span style="flex:1">' + esc(label) + '</span>' +
        '<button type="button" class="btn secondary" style="padding:.1rem .4rem" data-bup title="nach oben">↑</button>' +
        '<button type="button" class="btn secondary" style="padding:.1rem .4rem" data-bdown title="nach unten">↓</button>' +
        '<button type="button" class="btn danger" style="padding:.1rem .4rem" data-bdel title="Block löschen">×</button>';
      bar.appendChild(barRest);
      bar.querySelector('[data-bup]').onclick = function () { if (bi > 0) { moveTo(col.blocks, bi, bi - 1); render(); } };
      bar.querySelector('[data-bdown]').onclick = function () { if (bi < col.blocks.length - 1) { moveTo(col.blocks, bi, bi + 1); render(); } };
      bar.querySelector('[data-bdel]').onclick = function () {
        confirmFn('Block „' + label + '“ löschen?').then(function (yes) { if (yes) { col.blocks.splice(bi, 1); render(); } });
      };
      w.appendChild(bar);
      dropZone(w, 'block', function (d) {
        if (d.col === col && d.bi === bi) return;
        var item = d.col.blocks.splice(d.bi, 1)[0];
        col.blocks.splice(bi, 0, item); render();
      });

      var body = document.createElement('div');
      if (def) {
        def.render(body, b, ctx);
      } else {
        // Ein Block, den dieses Projekt nicht kennt: anzeigen, nicht anfassen, nicht verlieren.
        body.innerHTML = '<p style="font-size:.8rem;color:#991b1b;margin:0">Unbekannter Blocktyp „' + esc(b.type) + '“. Bleibt beim Speichern erhalten.</p>';
      }
      w.appendChild(body);
      return w;
    }

    function setLayout(row, key) {
      var spans = LAYOUTS[key] || LAYOUTS[Object.keys(LAYOUTS)[0]]; var old = row.columns || [];
      var cols = spans.map(function (sp, i) { return { span: sp, blocks: old[i] ? old[i].blocks : [] }; });
      for (var i = spans.length; i < old.length; i++) cols[cols.length - 1].blocks = cols[cols.length - 1].blocks.concat(old[i].blocks);
      row.layout = key; row.columns = cols;
    }
    function collect() {
      if (window.tinymce) window.tinymce.triggerSave();
      host.querySelectorAll('textarea.tinymce').forEach(function (ta) { if (ta._bind) ta._bind.obj[ta._bind.key] = ta.value; });
    }

    root.querySelector('[data-add-row]').onclick = function () {
      var key = root.querySelector('[data-new-layout]').value;
      var row = { layout: key, columns: [] }; setLayout(row, key);
      row.columns[0].blocks.push(blocks.rte.create());
      state.rows.push(row); render();
    };
    root.closest('form').addEventListener('submit', function () { collect(); input.value = JSON.stringify(state); });
    render();
  }

  // ---- Adresse aus dem Namen ---------------------------------------------
  function initSlugs() {
    document.querySelectorAll('[data-slug-from]').forEach(function (slugInput) {
      var src = document.querySelector('[name=' + slugInput.dataset.slugFrom + ']');
      if (!src) return;
      src.addEventListener('input', function () { if (!slugInput.dataset.touched && !slugInput.defaultValue) slugInput.value = slugify(src.value); });
      slugInput.addEventListener('input', function () { slugInput.dataset.touched = '1'; });
    });
  }
  function slugify(v) {
    return v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }

  function init() {
    document.querySelectorAll('[data-layout-editor]').forEach(initLayoutEditor);
    initSlugs();
    // Einfache Editoren ausserhalb des Rasters
    if (window.tinymce) initAllTiny(); else window.addEventListener('load', initAllTiny);
  }

  window.miniCms = {
    registerBlock: registerBlock, pickImage: pickImage, esc: esc, confirm: confirmFn, alert: alertFn,
    handle: handle, dropZone: dropZone, moveTo: moveTo, tinyOptions: {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
