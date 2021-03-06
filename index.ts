import pc from "picocolors"
import fs from 'fs-extra';
import path from 'path';
import chokidar from 'chokidar';
import fg from 'fast-glob';
//import mime from 'mime-types';
import toml from 'toml';
import child_process from 'child_process';
import { Plugin, ResolvedConfig } from 'vite';
import { useDebounceFn } from '@vueuse/core'

interface Options {

    crates: string[];
    out_dir: string;
    out_dir_dist: string;
    wasm_opt: boolean;
}

interface Crate {
    name: string;
    description: string;
    version: string;
    path: string;
}

// Note: No support for watch on vite build
export function BevyWasm(options: Options): Plugin {

    const virtualModuleId = 'virtual:vue-bevy';
    const resolvedVirtualModuleId = '\0' + virtualModuleId;
    let crates: Crate[] = [];
    let config: ResolvedConfig;

    return {
        name: 'vite-plugin-vue-bevy',
        configResolved(viteConfig) {
            config = viteConfig;
        },
        async buildStart(_inputOptions) {

            // create crate list
            crates = await getCrates();

            // for now doing them in order so debugging is sane
            crates.forEach(async (crate) => {
                if (config.command === 'serve') {
                    // reusable function to build a crate
                    const crateGenerate = (crate: Crate) => {

                        // Step 1: Build crate
                        const cargo_build_cmd = ['cargo', 'build', '--lib', '--package', crate.name, '--target', 'wasm32-unknown-unknown'];
                        console.log(pc.gray("[vue-bevy]"), `Running 'cargo build' for `, pc.white(pc.bold(crate.name)));
                        //console.log(cmd.join(' '));
                        const cargo_build = child_process.spawnSync(cargo_build_cmd.shift() as string, cargo_build_cmd, {
                            stdio: 'inherit'
                        });

                        if (cargo_build.status !== 0) {
                            console.error(pc.red("[vue-bevy]"), `Cargo build failed for ${crate.name}`);
                        }

                        // Step 2: generate wasm bindings
                        const wasm_out_dir = `${path.resolve(config.root, options.out_dir)}`;
                        const bindgen_cmd = ['wasm-bindgen',
                            `./target/wasm32-unknown-unknown/debug/${crate.name}.wasm`,
                            '--out-dir', wasm_out_dir,
                            '--out-name', `${crate.name}`,
                            '--target', 'web'];

                        console.log(pc.gray("[vue-bevy]"), 'Wasm-bindgen building', pc.white(pc.bold(crate.name)));
                        //console.log(bindgen_cmd.join(' '));
                        const wasm_bindgen = child_process.spawnSync(bindgen_cmd.shift() as string, bindgen_cmd, {
                            stdio: 'inherit'
                        });
                        if (wasm_bindgen.status !== 0) {
                            console.error(pc.red("[vue-bevy]"), `Cargo build failed for ${crate.name}`);
                        }

                        // Step 3: copy type defs file
                        const types_file = path.resolve(wasm_out_dir, `${crate.name}.d.ts`);
                        let types_files_source = fs.readFileSync( types_file, {
                            encoding: 'utf8'
                        } ).toString();
                        types_files_source = `
// Generated by 'vue-bevy' from wasm-bindgen
// See ${options.out_dir} for js
declare module 'virtual:vue-bevy/${crate.name}.js' {
    ${types_files_source}
}`;
                        //fs.writeFileSync( path.resolve(config.root, options.dts.replace('*.d.ts', `${crate.name}.d.ts`)), types_files_source );

                        // TODO: send hmr update
                    }
                    // called first time here on start
                    crateGenerate(crate);

                    const deboundBuild = useDebounceFn(() => {
                        crateGenerate(crate);
                    }, 5000);
                    // watch the crate and rebuild on change
                    // chokidar.watch(crate.path).on('all', (event, path) => {
                    //     // wrap crateGenerate in debounce so we can limit how often try to build
                    //    deboundBuild()
                    // });

                    // assets
                    // add alias for asset paths, so no coping is needed
                    // IMPORTANT: path needs to match bevy AssetServerSettings
                    config.resolve.alias.push({
                        find: `/assets/${crate.name}`,
                        replacement: `${crate.path}/assets/`
                    });
                } else {

                    // run cargo build
                    let cmd = ['cargo', 'build', '--package', crate.name, '--lib', '--target', 'wasm32-unknown-unknown', '--release'];
                    console.log(pc.gray("[vue-bevy]"), 'Cargo building ', pc.white(pc.bold(crate.name)));
                    console.log(cmd.join(' '));
                    child_process.spawnSync(cmd.shift() as string, cmd, {
                        stdio: 'inherit'
                    });

                    // run wasm-bindings
                    let binding_cmd = ['wasm-bindgen',
                        `./target/wasm32-unknown-unknown/release/${crate.name}.wasm`,
                        '--out-dir', `${path.resolve(config.root, options.out_dir_dist)}`,
                        '--out-name', crate.name,
                        '--target', 'web'];
                    console.log(pc.gray("[vue-bevy]"), 'Wasm-bindgen building', pc.white(pc.bold(crate.name)));
                    console.log(binding_cmd.join(' '));
                    child_process.spawnSync(binding_cmd.shift() as string, binding_cmd, {
                        stdio: 'inherit'
                    });

                    // run wasm-opt if enabled
                    if (options.wasm_opt) {
                        let wasm_opt_cmd = [
                            'wasm-opt',
                            '-Os',
                            '--enable-simd',
                            '--output', `${options.out_dir_dist}/${crate.name}.wasm`,
                            `${options.out_dir_dist}/${crate.name}_bg.wasm`
                        ];

                        console.log(pc.gray("[vue-bevy]"), 'Wasm-opt building', pc.white(pc.bold(crate.name)));
                        console.log(wasm_opt_cmd.join(' '));
                        child_process.spawnSync(wasm_opt_cmd.shift() as string, wasm_opt_cmd, {
                            stdio: 'inherit'
                        });
                    }

                    // assets - alias for asset paths, no copy needed
                    // IMPORTANT: path needs to match bevy AssetServerSettings
                    let assets = await fg(path.resolve(crate.path, 'assets', '**/*'), {
                        onlyFiles: true,
                    });
                    assets.forEach((file: string) => {
                        let relative_path = path.relative(path.resolve(crate.path, 'assets'), file);
                        // emit asset files for build system
                        this.emitFile({
                            type: 'asset',
                            fileName: `assets/${crate.name}/${relative_path}`,
                            source: fs.readFileSync(file),
                        });
                    });
                    // for (let file of assets) {


                    // }
                }
            });

            // TODO: move this or find better way
            // doesn't really belong here, but vite.config.ts would need crates list
            crates.forEach(async (crate) => {
                const readme_file = path.resolve(crate.path, 'readme.md');
                if (!fs.existsSync(readme_file)) {
                    console.warn(pc.gray("[vue-bevy]"), `No readme found in ${crate.name}`);
                }
                const file = path.resolve('src/pages', `${crate.name}.vue`);
                fs.writeFile(file,
                    `<script setup lang="ts">
// Generated by 'vue-bevy'
import ${crate.name}Readme from '../.${crate.path}/readme.md'
import init  from 'virtual:vue-bevy/${crate.name}.js'
import WebgpuNotes from '~/components/webgpu-notes.vue';
const gpu = (navigator as any).gpu;

tryOnMounted(async () => {
    if (gpu) {
        const wasm =  await init('virtual:vue-bevy/${crate.name}.wasm');
        wasm.run();
    }
});

const router = useRouter()
const { t } = useI18n()
</script>

<template>
    <${crate.name}Readme />
    <WebgpuNotes />
    <template v-if="gpu">
        Make sure canvas has focus <br />
        Hit F12 for editor<br />
        <canvas class="wasm" />
    </template>

    <button class="btn m-3 text-sm mt-6" @click="router.back()">
    {{ t("button.back") }}
    </button>

</template>

<style scoped>
.wasm {
    margin-left: auto;
    margin-right: auto;
}
</style>

<route lang="yaml">
meta:
    layout: wasm
</route>`);
            });


            async function getCrates(): Promise<Crate[]> {
                const files = await fg(options.crates);
                return files.map((file) => {
                    const cargo_dir = path.dirname(file);
                    // read cargo.toml file add info to crates
                    const cargo = toml.parse(fs.readFileSync(file, { encoding: 'utf-8' }));
                    return {
                        name: cargo.package.name,
                        description: cargo.package.description,
                        version: cargo.package.version,
                        path: cargo_dir,
                    };
                });
            }
        },
        resolveId(id) {
            if (id.indexOf(virtualModuleId) === 0) {
                return id.replace(virtualModuleId, resolvedVirtualModuleId);
            }
            return null;
        },

        async load(id) {
            if (id.indexOf(resolvedVirtualModuleId) === 0) {
                id = id.replace(resolvedVirtualModuleId, '');
                console.log(id);

                if (id === '/generated-wasms') {
                    return 'export const wasm_crates = ' + JSON.stringify(crates.map(c => {
                        return {
                            name: c.name,
                            description: c.description,
                            version: c.version
                        };
                    }));
                }
                // load the virtual module
                crates.forEach(crate => {
                    if (id.indexOf(`/${crate.name}.js`) === 0) {
                        const file = path.resolve( config.command === 'serve' ? options.out_dir : options.out_dir_dist, `${crate.name}.js`);                        
                        let source = fs.readFileSync(file, { encoding: 'utf-8' }).toString();
                        console.log("Serving file:", file, "\nServing source:", source);
                        return source;
                    }
                    if (id.indexOf(`/${crate.name}.wasm`) === 0) {
                        if (config.command == 'serve') {
                            const file = path.resolve( options.out_dir , `${crate.name}.wasm'`);
                            let source = fs.readFileSync(file, { encoding: 'utf-8' }).toString();
                            console.log("Serving file:", file, "\nServing source:", source);
                            return source;
                        } else {
                            const file_name = options.wasm_opt ? `${crate.name}.wasm` : `${crate.name}_bg.wasm`;
                            const file = path.resolve( options.out_dir_dist , file_name);
                            return fs.readFileSync(file, { encoding: 'utf-8' });
                        }
                    }
                });
            }
        },
        async buildEnd() {
            console.log("build end")
        }
    };
}