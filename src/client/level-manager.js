import * as THREE from "three";
import "three/examples/js/objects/Water";
import "three/examples/js/objects/Sky";
import "three/examples/js/loaders/LoaderSupport";
import "three/examples/js/loaders/GLTFLoader";
import { renderCore } from "./render/render-core";
import { CustomMaterial } from "./render/custom-material";
import * as LevelData from "../level/level-data";
import { marbleManager } from "./marble-manager";
import LevelLoaderWorker from "./level-loader.worker";
import * as config from "./config";

const _GLTFLoader = new THREE.GLTFLoader();

function MarbleLevel() { // "Map" is taken. This comment is left here in memory of "MarbleMap"
	this.scene = new THREE.Scene();
	this.levelObjects = new THREE.Scene(); // Scene for all loaded level objects
	this.scene.add(this.levelObjects);
	this.startingGates = [];

	// Ambient light
	let ambientLight = new THREE.AmbientLight(0x746070);
	this.scene.add(ambientLight);

	// Sky + Sunlight
	this.sky = new Sky();
	this.scene.add(this.sky.group);

	// Water
	this.water = new Water(this, this.sky.sunLight);
	this.scene.add(this.water.waterObject);
	this.sky.water = this.water;

	// Level Data
	this.levelName = null;
	this.authorName = null;

	// Loader thread handle
	this.loader = null;

	// Load default level properties
	this.loadLevel(new LevelData());
}

MarbleLevel.prototype.update = function(deltaTime) {
	this.water.update(deltaTime);
};

MarbleLevel.prototype.openGates = function() {
	for(let i = 0; i < this.startingGates.length; i++) {
		this.startingGates[i].visible = false;
	}
};

MarbleLevel.prototype.closeGates = function() {
	for(let i = 0; i < this.startingGates.length; i++) {
		this.startingGates[i].visible = true;
	}
};

// Fetches and loads the level asynchronously. Returns a Promise that resolves when loading is complete
MarbleLevel.prototype.loadLevelFromUrl = function(url) {
	if(this.loader) {
		console.warn(`Can't load ${url} because this MarbleLevel is already loading a level.`);
		return Promise.resolve();
	}
	this.loader = new LevelLoaderWorker();
	return new Promise( (resolve, reject) => {
		this.loader.onmessage = function(result) {
			if(result.data.success) {
				let loadedLevel = result.data.payload;
				Object.setPrototypeOf(loadedLevel, LevelData.prototype);
				resolve(loadedLevel);
			} else {
				reject(result.data.payload);
			}
		};
		this.loader.onerror = function(error) {
			reject(error.message);
		};
		this.loader.postMessage({url});
	}).then( (result) => {
		this.loader.terminate();
		this.loader = null;
		return this.loadLevel(result);
	}).catch( (error) => {
		this.loader.terminate();
		this.loader = null;
		console.error(`Level loading failed: ${error}`);
		return "failed";
	});
};

// Parses the level data and returns a Promise that resolves once it is fully done loading
MarbleLevel.prototype.loadLevel = function(data) {
	// Reset loaded data if there is any
	this.scene.remove(this.levelObjects);
	this.startingGates = [];
	this.levelObjects = new THREE.Scene();
	this.levelObjects.matrixAutoUpdate = false;
	this.levelObjects.autoUpdate = false;
	this.scene.add(this.levelObjects);

	// Load environmental variables
	this.water.setHeight(data.world.waterLevel);
	this.sky.recalculate({ inclination: data.world.sunInclination });

	// Set level meta data
	this.levelName = data.levelName;
	this.authorName = data.authorName;

	// Load textures
	let textures = {};
	for (let textureUuid in data.textures) {
		textures[textureUuid] = new THREE.TextureLoader().load(data.textures[textureUuid].file);
		textures[textureUuid].wrapS = textures[textureUuid].wrapT = THREE.RepeatWrapping;
	}

	// Load materials
	let materials = {};
	for (let materialUuid in data.materials) {
		// For each material property that uses a texture, set the appropriate texture in the data so it can be used by CustomMaterial
		let textureProperties = ["diffuse-a", "diffuse-b", "mask", "normal-a", "normal-b"];
		for (let property of textureProperties) {
			let materialProperty = data.materials[materialUuid][property];
			if (materialProperty.textureUuid) {
				materialProperty.texture = textures[materialProperty.textureUuid];
			} else {
				data.materials[materialUuid][property] = null;
			}
		}

		// Create an object that can be parsed by CustomMaterial
		let properties = {
			side:	   data.materials[materialUuid].side,
			roughness: data.materials[materialUuid].roughness,
			metalness: data.materials[materialUuid].metalness,
			diffuseA:  data.materials[materialUuid]["diffuse-a"],
			diffuseB:  data.materials[materialUuid]["diffuse-b"],
			mask:	   data.materials[materialUuid]["mask"],
			normalA:   data.materials[materialUuid]["normal-a"],
			normalB:   data.materials[materialUuid]["normal-b"]
		};

		try {
			materials[materialUuid] = (new CustomMaterial(properties)).material;
			materials[materialUuid].needsUpdate = true;
		} catch (error) {
			console.warn(error);
		}
	}

	// Load models & childMeshes, apply custom materials where appropriate
	let childNumber = null;
	function setChildMeshMaterials(obj, childMeshes) {
		let children = [];

		if (obj.type === "Mesh") {
			if (materials[childMeshes[childNumber].material] != null) {
				obj.material = materials[childMeshes[childNumber].material];
			}
			obj.castShadow = config.graphics.castShadow.level;
			obj.receiveShadow = config.graphics.receiveShadow.level;
			childNumber++;
		}

		for (let c = 0; c < obj.children.length; c++) {
			children = children.concat(setChildMeshMaterials(obj.children[c], childMeshes));
		}
		return children;
	}

	let modelPromises = [];
	let models = {};
	for (let modelName in data.models) {
		modelPromises.push(
			new Promise((resolve, reject) => {
				try {
					_GLTFLoader.parse(data.models[modelName].file, null,
						function(model) {
							if (data.models[modelName].childMeshes.length > 0) {
								childNumber = 0;
								setChildMeshMaterials(model.scene, data.models[modelName].childMeshes);
							}
							models[modelName] = model.scene;
							resolve();
						}, function(error) {
							reject(error);
						}
					);
				}
				catch (error) {
					// Invalid JSON/GLTF files may end up here
					reject(error);
				}
			}).catch((error) => {
				console.warn(`Unable to load model (${modelName}), using fallback model instead`, error);
				models[modelName] = null;
			})
		);
	}

	// Load prefabs
	let prefabs = {};
	return Promise.all(modelPromises).then(() => {
		let warnings = 0;
		for (let prefabUuid in data.prefabs) {
			let group = new THREE.Group();

			for (let entity of Object.values(data.prefabs[prefabUuid].entities)) {
				if (entity.type === "object" && entity.model) {
					let clone;
					if(!models[entity.model]) {
						clone = renderCore.getDefaultModel().clone();
						warnings++;
					}
					else {
						clone = models[entity.model].clone();
					}

					clone.userData.functionality = entity.functionality;
					clone.position.copy(new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z));
					clone.setRotationFromQuaternion(new THREE.Quaternion(entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w));
					clone.scale.copy(new THREE.Vector3(entity.scale.x, entity.scale.y, entity.scale.z));
					group.add(clone);
				}
			}

			prefabs[prefabUuid] = group;
		}

		// World objects
		for (let object of Object.values(data.worldObjects)) {
			let clone = prefabs[object.prefab].clone();
			clone.position.copy(new THREE.Vector3(object.position.x, object.position.y, object.position.z));
			clone.setRotationFromQuaternion(new THREE.Quaternion(object.rotation.x, object.rotation.y, object.rotation.z, object.rotation.w));
			this.levelObjects.add(clone);

			// Keep starting gate prefabObjects in a separate array for opening/closing
			for(let i = 0; i < clone.children.length; i++) {
				if(clone.children[i].userData.functionality === "startgate") {
					this.startingGates.push(clone.children[i]);
				}
			}
		}
		// Disable matrix updates
		this.levelObjects.traverse( (obj) => {
			obj.updateMatrix();
			obj.matrixAutoUpdate = false;
		});
		return warnings;
	});
};

// Water
function Water(parent, sunLight, waterLevel = 0, fog = false) {
	this.parent = parent; // The owning MarbleLevel
	let geometry = this.geometry = new THREE.PlaneBufferGeometry(10000, 10000);

	this.waterObject = new THREE.Water(
		geometry,
		{
			textureWidth: 512,
			textureHeight: 512,
			waterNormals: new THREE.TextureLoader().load("resources/textures/waternormals.jpg", function(texture) {
				texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
			}),
			alpha: 1.0,
			sunDirection: sunLight.position.clone().normalize(),
			sunColor: 0xffffff,
			waterColor: 0x001e0f,
			distortionScale: 3.7,
			fog
		}
	);

	this.waterObject.rotation.x = -Math.PI / 2;
	this.waterObject.position.y = waterLevel;
	this.waterObject.material.uniforms.size.value = 8;
	let originalOnBeforeRender = this.waterObject.onBeforeRender;
	this.waterObject.onBeforeRender = function(renderer, scene, camera) {
		if(!renderCore.waterReflectsLevel()) parent.levelObjects.visible = false;
		if(!renderCore.waterReflectsMarbles()) marbleManager.marbleGroup.visible = false;
		camera.layers.disable(renderCore.SPRITE_LAYER);

		originalOnBeforeRender(renderer, scene, camera);

		parent.levelObjects.visible = true;
		marbleManager.marbleGroup.visible = true;
		camera.layers.enable(renderCore.SPRITE_LAYER);
	};
}

Water.prototype.setHeight = function(newHeight) {
	this.waterObject.position.y = newHeight;
};

Water.prototype.update = function(deltaTime) {
	this.waterObject.material.uniforms.time.value += deltaTime;
};

// Skybox
function Sky(parameters = {}) {
	// Wrapper group for all entities related to the sky
	this.group = new THREE.Group();
	this.skyObject = new THREE.Sky();
	this.skyObject.scale.setScalar(10000);
	this.group.add(this.skyObject);

	// Light
	let sunLight = this.sunLight = new THREE.DirectionalLight(0xf5d0d0, 1.5);
	sunLight.castShadow = true;

	this.group.add(sunLight);

	let uniforms = this.skyObject.material.uniforms;
	uniforms.turbidity.value = 10;
	uniforms.rayleigh.value = 2;
	uniforms.luminance.value = 1;
	uniforms.mieCoefficient.value = 0.005;
	uniforms.mieDirectionalG.value = 0.8;

	this.parameters = parameters;
	this.parameters.distance	= !isNaN(parameters.distance)	 ? parameters.distance	  : 4000;
	this.parameters.inclination = !isNaN(parameters.inclination) ? parameters.inclination : .25;
	this.parameters.azimuth		= !isNaN(parameters.azimuth)	 ? parameters.azimuth	  : .205;
	this.recalculate();
}

Sky.prototype.recalculate = function(parameters) {
	// parameters variable is optional, if you wish to change them before recalculating
	if (parameters) {
		if (typeof parameters.distance	  !== "undefined") this.parameters.distance	   = parameters.distance;
		if (typeof parameters.inclination !== "undefined") this.parameters.inclination = parameters.inclination;
		if (typeof parameters.azimuth	  !== "undefined") this.parameters.azimuth	   = parameters.azimuth;
	}

	let theta = Math.PI * (this.parameters.inclination - 0.5);
	let phi = 2 * Math.PI * (this.parameters.azimuth - 0.5);

	this.sunLight.position.x = this.parameters.distance * Math.cos(phi);
	this.sunLight.position.y = this.parameters.distance * Math.sin(phi) * Math.sin(theta);
	this.sunLight.position.z = this.parameters.distance * Math.sin(phi) * Math.cos(theta);

	this.skyObject.material.uniforms.sunPosition.value = this.sunLight.position.copy(this.sunLight.position);
	this.sunLight.shadow.mapSize.width = 2048; // default
	this.sunLight.shadow.mapSize.height = 2048; // default
	this.sunLight.shadow.camera.near = 3500;
	this.sunLight.shadow.camera.far = 4200;
	this.sunLight.shadow.camera.left = -69;
	this.sunLight.shadow.camera.right = 60;
	this.sunLight.shadow.camera.top = 50;
	this.sunLight.shadow.camera.bottom = -30;

	if (this.water) {
		this.water.waterObject.material.uniforms.sunDirection.value.copy(this.sunLight.position).normalize();
	}
};

Sky.prototype.toggleDebugHelper = function(state) {
	if (!this.shadowHelper && state) this.shadowHelper = new THREE.CameraHelper(this.sunLight.shadow.camera);
	if (state) {
		this.group.add(this.shadowHelper);
	} else if (this.shadowHelper) {
		this.group.remove(this.shadowHelper);
	}
};


let levelManager = function() {
	return {
		activeLevel: null,

		initialize: function() {
			this.setActiveLevel(new MarbleLevel());
		},

		// Set a new active level
		setActiveLevel: function(marbleLevel) {
			if (this.activeLevel) {
				renderCore.mainScene.remove(this.activeLevel.scene);
			}
			this.activeLevel = marbleLevel;
			renderCore.mainScene.add(this.activeLevel.scene);
		}
	};
}();

export {
	levelManager
};
