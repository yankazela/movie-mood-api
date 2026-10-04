const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "src/api");
const distDir = path.join(__dirname, "dist/api");

// Lambda code imports ResponseService/ValidationService from the @novha/cdk-lib barrel,
// which also re-exports CDK constructs that require aws-cdk-lib. Those constructs only
// touch aws-cdk-lib inside methods that never run in a Lambda, so stub the module out
// instead of bundling ~60 MB of CDK into every function.
const stubCdkPlugin = {
    name: "stub-aws-cdk-lib",
    setup(build) {
        build.onResolve({ filter: /^(aws-cdk-lib|constructs)(\/|$)/ }, (args) => ({
            path: args.path,
            namespace: "cdk-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "cdk-stub" }, () => ({
            contents: "module.exports = {};",
            loader: "js",
        }));
    },
};

async function buildAll() {
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // One bundle per src/api/<name>/index.ts, written to dist/api/<name>/index.js.
    for (const lambdaName of fs.readdirSync(srcDir)) {
        const lambdaPath = path.join(srcDir, lambdaName, "index.ts");

        if (!fs.existsSync(lambdaPath)) {
            continue;
        }

        await esbuild.build({
            entryPoints: [lambdaPath],
            bundle: true,
            platform: "node",
            target: "node18",
            outdir: path.join(distDir, lambdaName),
            plugins: [stubCdkPlugin],
        });

        console.log(`Built: ${lambdaName}`);
    }
}

buildAll().catch((error) => {
    console.error(error);
    process.exit(1);
});
