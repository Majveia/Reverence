# vendor/

Third-party code shipped with the project so it runs with no install step and no build step.

- `three/` — [three.js](https://threejs.org) r187 (MIT). `build/` is the WebGL build; `addons/` is the
  subset of `examples/jsm` that works with `WebGLRenderer` (WebGPU/TSL-only files removed).

Import through the import map in `index.html`:

```js
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
```
