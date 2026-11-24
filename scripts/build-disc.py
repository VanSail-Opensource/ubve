#!/usr/bin/env python3
"""Reproduce the pinned, read-only disc WASM; no media data enters the build."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--emsdk', required=True, type=pathlib.Path)
p.add_argument('--build-tools', required=True, type=pathlib.Path, help='Directory containing meson and ninja')
p.add_argument('--build-root', type=pathlib.Path, default=ROOT/'.local/disc-build')
a = p.parse_args()
a.emsdk=a.emsdk.resolve(); a.build_tools=a.build_tools.resolve();a.build_root=a.build_root.resolve()
a.build_root.mkdir(parents=True,exist_ok=True)
env=os.environ.copy(); env['PATH']=str(a.build_tools)+os.pathsep+env.get('PATH','')
def run(args): subprocess.run([str(x) for x in args],env=env,check=True)
em=a.emsdk/'upstream/emscripten'
version=subprocess.check_output([str(em/'emcc'),'--version'],text=True)
if not version.splitlines()[0].startswith('emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.0 '):
 raise SystemExit('Exact Emscripten 6.0.0 required')
manifest=json.loads((ROOT/'third_party/disc/manifest.json').read_text())
stage=a.build_root/'stage'
patches={'packages/disc/native/no-dynamic-loading.c':'src/file/dl_posix.c',
         'packages/disc/native/no-persistent-properties.c':'src/libbluray/disc/properties.c'}
cross=a.build_root/'wasm-cross.ini'
cross.write_text(f"""[binaries]\nc = '{em}/emcc'\nar = '{em}/emar'\nranlib = '{em}/emranlib'\npkg-config = 'pkg-config'\n[host_machine]\nsystem = 'emscripten'\ncpu_family = 'wasm32'\ncpu = 'wasm32'\nendian = 'little'\n[properties]\nneeds_exe_wrapper = true\npkg_config_libdir = ['{stage}/lib/pkgconfig']\n[built-in options]\nc_args = ['-O3', '-fPIC']\nc_link_args = ['-O3']\n""")
for name in ('libudfread','libbluray'):
 entry=manifest[name]; archive=ROOT/'third_party/disc'/f"{name}-{entry['version']}.tar.xz"
 alg='sha512' if 'sha512' in entry else 'sha256'
 if hashlib.new(alg,archive.read_bytes()).hexdigest()!=entry[alg]:raise SystemExit('Source archive mismatch: '+name)
 source=a.build_root/f"{name}-{entry['version']}"
 if not source.exists():
  with tarfile.open(archive) as t:t.extractall(a.build_root,filter='data')
 meson=source/'meson.build'; text=meson.read_text()
 old="dependency('threads', required: false)" if name=='libudfread' else "dependency('threads')"
 replacement='declare_dependency() # UBVE: single dedicated worker, no pthread pool'
 if old in text:
  if text.count(old)!=1:raise SystemExit('Unexpected thread dependency source')
  meson.write_text(text.replace(old,replacement))
 elif replacement not in text:raise SystemExit('Unexpected previously patched source')
 if name=='libbluray':
  for local,upstream in patches.items():shutil.copyfile(ROOT/local,source/upstream)
 build=a.build_root/f'build-{name}'
 args=[a.build_tools/'meson','setup',build,source,'--cross-file',cross,'--prefix',stage,'-Ddefault_library=static','-Denable_examples=false','--wrap-mode=nofallback']
 if (build/'meson-private/coredata.dat').exists():args.append('--reconfigure')
 if name=='libbluray':args+=['-Denable_tools=false','-Denable_devtools=false','-Dbdj_jar=disabled','-Dfreetype=disabled','-Dfontconfig=disabled','-Dlibxml2=disabled','-Dembed_udfread=false']
 env['PKG_CONFIG_LIBDIR']=str(stage/'lib/pkgconfig')
 run(args);run([a.build_tools/'ninja','-C',build,'-j','2','install'])
out=ROOT/'packages/disc/runtime';out.mkdir(parents=True,exist_ok=True)
run([em/'emcc',ROOT/'packages/disc/native/disc-bridge.c',stage/'lib/libbluray.a',stage/'lib/libudfread.a','-I'+str(stage/'include'),'-O3','-g0','-sASSERTIONS=1','-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=worker,node','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sINITIAL_MEMORY=16777216','-sMAXIMUM_MEMORY=134217728','-sEXPORTED_FUNCTIONS=["_malloc","_free"]','-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8"]','-o',out/'ubve-disc.mjs'])
records=[]
for file in sorted(out.glob('ubve-disc.*')):
 records.append({'path':str(file.relative_to(ROOT)),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(out/'build-manifest.json').write_text(json.dumps({'schema':1,'compiler':version.splitlines()[0],'sources':manifest,'shimSha256':hashlib.sha256((ROOT/'packages/disc/native/disc-bridge.c').read_bytes()).hexdigest(),'patches':[{ 'path':local,'upstreamPath':upstream,'sha256':hashlib.sha256((ROOT/local).read_bytes()).hexdigest() } for local,upstream in patches.items()],'assets':records,'memoryMaximumBytes':134217728,'pthreadPoolSize':0,'assertions':True,'publicAbiAudit':'unminified WASM imports and exports','qualification':'UNQUALIFIED'},indent=2)+'\n')
print(json.dumps(records,indent=2))
