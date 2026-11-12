#!/usr/bin/env python3
"""Apply visible Helide strings/icons after upstream name/translation/resources.

Internal URLs, preference keys, executable/profile names and upstream attribution
are intentionally unchanged. Uses upstream GRIT fingerprint machinery so changed
English messages and their translations keep matching.
"""
import argparse
from copy import deepcopy
from datetime import datetime
import hashlib
import re
import subprocess
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'helium-chromium/utils'))
import name_substitution as names
import name_substitution_utils as util


def write_changed(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def brand_strings(tree, backups):
    util.add_grit_to_path(tree)
    # Visible product name only. Do not change helium://, URLs or legal authors.
    util.REPLACEMENT_REGEXES = [(re.compile(r'\bHelium\b(?!\s+Authors)'), 'Helide')]
    original_replace = util.replace_grit_message
    protected = set()

    def replace_message(message):
        if message.tag == 'message' and re.search(
                r'COPYRIGHT|COMPANY_NAME|LICENSE|TERMS|CREDITS', message.get('name', '')):
            protected.add(util.compute_fp(message))
            return False
        return original_replace(message)

    def replace_translation(message, fp_map):
        old_id = message.get('id')
        if old_id in protected:
            return False
        changed = replace_message(message)
        if old_id in fp_map:
            message.set('id', str(fp_map[old_id]))
            changed = True
        return changed

    util.replace_grit_message = replace_message
    util.replace_xtb_translation = replace_translation
    files = names.get_substitutable_files(tree, ['grd', 'grdp'])
    results = []
    for path in files:
        result = names.substitute_grit_file((path, tree, True, False))
        if result is not None:
            results.append(result)
    fp_map = util.merge_fp_maps(results)
    originals = [result[0] for result in results]
    for path in names.get_substitutable_files(tree, ['xtb']):
        result = names.substitute_xtb_file((path, tree, fp_map, True, False))
        if result is not None:
            originals.append(result[0])
    if originals:
        backup = backups / f'strings-{datetime.now():%Y%m%d-%H%M%S-%f}.tar.gz'
        backup.parent.mkdir(parents=True, exist_ok=True)
        names.maybe_make_tarball(backup, originals)
        print(f'Backed up {len(originals)} string files: {backup}')
    print(f'Helide strings: {len(originals)} files changed')


def vector_icon(svg):
    """Monochrome form of the SVG's two core paths (gradients stay in PNG/SVG)."""
    commands = {'M': ('MOVE_TO', 2), 'L': ('LINE_TO', 2), 'H': ('H_LINE_TO', 1),
                'V': ('V_LINE_TO', 1), 'C': ('CUBIC_TO', 6), 'Z': ('CLOSE', 0)}
    output = ['// Helide mark, derived from helide-icon.svg.',
              'CANVAS_DIMENSIONS, 56,', 'FILL_RULE_NONZERO,']
    width = float(svg.get('viewBox').split()[2])
    for path in svg.findall('.//{http://www.w3.org/2000/svg}path'):
        tokens = re.findall(r'[A-Za-z]|-?\d+(?:\.\d+)?', path.get('d'))
        while tokens:
            symbol = tokens.pop(0)
            if symbol not in commands:
                raise ValueError(f'Unsupported SVG path command: {symbol}')
            command, count = commands[symbol]
            values = [float(tokens.pop(0)) * 56 / width for _ in range(count)]
            output.append(command + (', ' + ', '.join(f'{v:.5f}f' for v in values) if count else '') + ',')
    return ('\n'.join(output) + '\n').encode()


def brand_icons(tree, cache):
    source = ROOT / 'helide-icon.svg'
    svg = ET.fromstring(source.read_text())
    cache.mkdir(parents=True, exist_ok=True)
    stamp = cache / 'source.sha256'
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    sizes = [16, 22, 24, 32, 48, 64, 128, 256]
    if not stamp.exists() or stamp.read_text() != digest or any(
            not (cache / f'{size}.png').exists() for size in sizes):
        for size in sizes:
            subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                            '-o', str(cache / f'{size}.png'), str(source)], check=True)
        # A solid monochrome core for symbolic assets, without the background tile.
        mono = ET.Element('{http://www.w3.org/2000/svg}svg', viewBox=svg.get('viewBox'))
        for path in svg.findall('.//{http://www.w3.org/2000/svg}path'):
            ET.SubElement(mono, '{http://www.w3.org/2000/svg}path', d=path.get('d'), fill='black')
        mono_path = cache / 'mono.svg'
        mono_path.write_bytes(ET.tostring(mono))
        subprocess.run(['rsvg-convert', '-w', '22', '-h', '22', '-o', str(cache / 'mono.png'), str(mono_path)], check=True)
        for variant, color in [('wordmark', '#202124'), ('wordmark-white', '#ffffff')]:
            wordmark = ET.Element('{http://www.w3.org/2000/svg}svg', viewBox='0 0 140 32')
            mark = deepcopy(svg)
            mark.set('width', '32')
            mark.set('height', '32')
            wordmark.append(mark)
            label = ET.SubElement(wordmark, '{http://www.w3.org/2000/svg}text',
                                  x='40', y='25', fill=color,
                                  attrib={'font-family': 'sans-serif', 'font-size': '25', 'font-weight': '500'})
            label.text = 'Helide'
            wordmark_path = cache / f'{variant}.svg'
            wordmark_path.write_bytes(ET.tostring(wordmark))
            for scale in [1, 2]:
                subprocess.run(['rsvg-convert', '-w', str(140 * scale), '-h', str(32 * scale),
                                '-o', str(cache / f'{variant}-{scale}.png'), str(wordmark_path)], check=True)
        stamp.write_text(digest)

    # Follow upstream's complete icon replacement list rather than guessing paths.
    for line in (ROOT / 'helium-chromium/resources/helium_resources.txt').read_text().splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        origin, destination = parts
        data = None
        match = re.fullmatch(r'generated/product_icon/(\d+)x\d+\.png', origin)
        if match:
            data = (cache / f'{match[1]}.png').read_bytes()
        elif origin.startswith('branding/product_logo'):
            if origin.endswith('.svg'):
                data = source.read_bytes()
            elif origin.endswith('.icon'):
                data = vector_icon(svg)
            elif '22_mono' in origin:
                data = (cache / 'mono.png').read_bytes()
            elif origin.endswith('.png'):
                variant = 'wordmark-white' if '_white' in origin else 'wordmark'
                scale = 2 if '_200' in origin else 1
                data = (cache / f'{variant}-{scale}.png').read_bytes()
        if data is not None:
            write_changed(tree / destination, data)
    print('Helide PNG, SVG and monochrome vector icons applied')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tree', type=Path, default=ROOT / 'build/src')
    parser.add_argument('--icons-only', action='store_true')
    args = parser.parse_args()
    if not (args.tree / 'chrome/app/theme/chromium/BRANDING').exists():
        parser.error('Expected a patched Chromium source tree')
    cache = args.tree.parent / 'helide-branding'
    if not args.icons_only:
        brand_strings(args.tree, cache / 'backups')
    # Onboarding's custom preserveOrder XML parser expects <grit-part> as
    # its first node, unlike GRIT itself. ElementTree adds a declaration.
    for path in (args.tree / 'components/helium_onboarding').rglob('*.grdp'):
        data = path.read_bytes()
        data = re.sub(br'^<\?xml[^>]*\?>\s*', b'', data)
        write_changed(path, data)
    brand_icons(args.tree, cache)


if __name__ == '__main__':
    main()
