"""Build separate relocatable GUI/TUI archives; never contact a Pi-hole."""
import glob
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


platform, suffix = sys.argv[1:]
version = json.loads(Path('package.json').read_text())['version']
ext = '.exe' if platform.startswith('windows') else ''
root = Path('dist')
root.mkdir(exist_ok=True)
for kind, binaries in [('tui', ['pihole-export']), ('gui', ['pihole-desktop'])]:
    stage = Path('package-stage') / kind
    stage.mkdir(parents=True, exist_ok=True)
    for binary in binaries:
        source = Path('bin' if kind == 'tui' else 'target/release') / (binary + ext)
        shutil.copy2(source, stage / source.name)
    shutil.copy2('LICENSE', stage / 'LICENSE')
    if platform.startswith('linux'):
        lib = stage / 'lib'
        lib.mkdir(exist_ok=True)
        pending = [stage / (binary + ext) for binary in binaries]
        if kind == 'gui':
            # Winit loads these at runtime, so ldd alone is insufficient.
            for name in ['libxkbcommon.so.0', 'libxkbcommon-x11.so.0', 'libwayland-client.so.0',
                         'libX11.so.6', 'libXcursor.so.1', 'libXi.so.6', 'libXrandr.so.2',
                         'libXinerama.so.1', 'libvulkan.so.1']:
                matches = glob.glob('/usr/lib/x86_64-linux-gnu/' + name)
                if not matches:
                    raise RuntimeError('Missing runtime library: ' + name)
                pending.append(Path(matches[0]))
        seen = set()
        notices = stage / 'runtime-licenses'
        notices.mkdir(exist_ok=True)
        while pending:
            item = pending.pop()
            if item.name in seen:
                continue
            seen.add(item.name)
            if '.so' in item.name:
                shutil.copy2(item.resolve(), lib / item.name)
                owners = subprocess.run(['dpkg-query', '-S', str(item)], capture_output=True, text=True).stdout
                for owner in owners.splitlines():
                    package = owner.split(': ')[0].split(':')[0]
                    copyright = Path('/usr/share/doc') / package / 'copyright'
                    if copyright.exists():
                        shutil.copy2(copyright, notices / (package + '.txt'))
            output = subprocess.check_output(['ldd', str(item)], text=True)
            if 'not found' in output:
                raise RuntimeError(output)
            for name, path in re.findall(r'(\S+) => (/\S+)', output):
                # glibc and the GPU driver belong to the target OS, not this bundle.
                if not re.match(r'lib(c|m|pthread|dl|rt|resolv)\.so', name):
                    pending.append(Path(path))
    name = f'pihole-export-{kind}-v{version}{suffix}-{platform}{ext}'
    if platform.startswith('linux') and kind == 'gui':
        payload = Path('package-stage/payload.rs')
        entries = []
        for file in sorted(stage.rglob('*')):
            if file.is_file():
                entries.append('(' + json.dumps(file.relative_to(stage).as_posix()) + ', include_bytes!(' + json.dumps(str(file.resolve())) + ')),')
        payload.write_text('static PAYLOAD: &[(&str, &[u8])] = &[\n'+'\n'.join(entries)+'\n];\n')
        shutil.copy2('scripts/linux-launcher.rs', 'package-stage/linux-launcher.rs')
        subprocess.run(['rustc','--edition=2024','-C','opt-level=2','package-stage/linux-launcher.rs','-o',str(root/name)],check=True)
    else:
        shutil.copy2(stage / (binaries[0]+ext), root/name)
    print(root/name)
