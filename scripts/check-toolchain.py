import subprocess
for tool, series in [('rustc', '1.100.'), ('bun', '1.4.')]:
    version = subprocess.check_output([tool, '--version'], text=True).strip()
    actual = version.split()[1] if tool == 'rustc' else version
    assert actual.startswith(series), (tool, actual, series)
    print(version)
