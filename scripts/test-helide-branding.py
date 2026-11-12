#!/usr/bin/env python3
"""Regression tests for the branding overlay; requires build/src/tools/grit."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
GRIT = ROOT / 'build/src/tools/grit'
sys.path.insert(0, str(ROOT / 'helium-chromium/utils'))
import name_substitution_utils as util


@unittest.skipUnless(GRIT.exists(), 'Requires the downloaded Chromium GRIT tools')
class BrandingTest(unittest.TestCase):
    def test_strings_translations_icons_and_idempotence(self):
        util.add_grit_to_path(ROOT / 'build/src')
        with tempfile.TemporaryDirectory(prefix='helide-branding-test-') as directory:
            tree = Path(directory) / 'src'
            (tree / 'tools').mkdir(parents=True)
            (tree / 'tools/grit').symlink_to(GRIT)
            branding = tree / 'chrome/app/theme/chromium/BRANDING'
            branding.parent.mkdir(parents=True)
            branding.write_text('PRODUCT_FULLNAME=Helium\n')
            resource = tree / 'test.grdp'
            resource.write_text('''<grit-part>
<message name="IDS_TEST_NAME">Open Helium</message>
<message name="IDS_TEST_COPYRIGHT">The Helium Authors</message>
<message name="IDS_TEST_URL">Open helium://settings</message>
</grit-part>''')
            message = ET.fromstring(resource.read_text()).find('message')
            old_id = util.compute_fp(message)
            message.text = 'Open Helide'
            new_id = util.compute_fp(message)
            translated = tree / 'test.xtb'
            # Translation contains no Latin product name, but still needs its
            # fingerprint remapped to the changed source message.
            translated.write_text(f'''<translationbundle lang="fr">
<translation id="{old_id}">Ouvrir le navigateur</translation>
</translationbundle>''')
            onboarding = tree / 'components/helium_onboarding/test.grdp'
            onboarding.parent.mkdir(parents=True)
            onboarding.write_text('<grit-part><message name="IDS_TEST_WELCOME">Welcome to Helium</message></grit-part>')
            command = [sys.executable, str(ROOT / 'scripts/apply-helide-branding.py'), '--tree', str(tree)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertIn('Open Helide', resource.read_text())
            self.assertIn('The Helium Authors', resource.read_text())
            self.assertIn('helium://settings', resource.read_text())
            self.assertEqual(branding.read_text(), 'PRODUCT_FULLNAME=Helium\n')
            translation = ET.fromstring(translated.read_text()).find('translation')
            self.assertEqual(translation.get('id'), new_id)
            self.assertEqual(translation.text, 'Ouvrir le navigateur')
            self.assertTrue(onboarding.read_text().startswith('<grit-part>'))
            self.assertIn('Welcome to Helide', onboarding.read_text())
            icon = tree / 'chrome/app/theme/chromium/linux/product_logo_256.png'
            self.assertEqual(icon.read_bytes()[:8], b'\x89PNG\r\n\x1a\n')
            vector = tree / 'chrome/app/vector_icons/browser_logo.icon'
            self.assertIn('CUBIC_TO', vector.read_text())
            paths = [resource, translated, onboarding, icon, vector]
            before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in paths}
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertIn('Helide strings: 0 files changed', result.stdout)
            for path in paths:
                self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before[path])


if __name__ == '__main__':
    unittest.main()
