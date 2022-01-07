import pc from "picocolors"
import fs from 'fs-extra';
import path from 'path';
import fg from 'fast-glob';
import toml from 'toml';
import child_process from 'child_process';
import { Plugin, ResolvedConfig } from 'vite';

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
            crates = await getCrates(options.crates);

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
                            console.error(pc.red("[vue-bevy]"), `Wasm-bindgen build failed for ${crate.name}`);
                        }

                        // TODO: send hmr update
                    }
                    // called first time here on start
                    crateGenerate(crate);

                    const deboundBuild = debounceFn(() => {
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

                    // add an alias for dist path
                    config.resolve.alias.push({
                        find: `~/wasm/`,
                        replacement: `~/wasm_dist/`
                    });
                }
            });
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

            }
        },
        async buildEnd() {
            console.log("build end")
        }
    };
}

export async function getCrates(crates: string[]): Promise<Crate[]> {
    const files = await fg(crates);
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

// Returns a function, that, as long as it continues to be invoked, will not
// be triggered. The function will be called after it stops being called for
// `wait` milliseconds.
const debounceFn = (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout;

    return function executedFunction(...args: any[]) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };

        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};