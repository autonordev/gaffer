/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename */
const path = require('node:path')
const fs = require('node:fs')
const jsonc = require('comment-json')
const { merge } = require('lodash')

const log = require('../../helpers/log')

const importJson = (jsonPath) => {
  if (fs.existsSync(jsonPath)) {
    const input = fs.readFileSync(jsonPath, 'utf-8')
    const data = jsonc.parse(input, null, true)
    return data
  }
}

const baseTree = importJson(path.resolve(__dirname, 'base-tree.json'))

const importTree = (scheme) => {
  const treePath = path.resolve(scheme.path, 'tree.json')
  if (fs.existsSync(treePath)) {
    return importJson(treePath) || {}
  }
  return {}
}

const transformProperties = (properties) => {
  for (const name in properties) {
    const value = properties[name]
    if (typeof value === 'object') {
      // Used on properties that are a Color3 type, but when we'd like to write them in RGB
      if (value.Color3RGB) {
        const rgb = value.Color3RGB
        value.Color3 = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]
        value.Color3RGB = undefined
      }
    }
  }
}

const transformNode = (parentNode, projectPath, includePath, rootPath) => {
  const divergentPaths = projectPath !== includePath
  const relativePath = divergentPaths && path.relative(projectPath, includePath)
  const relativeRoot = path.relative(projectPath, rootPath)

  for (const nodeKey in parentNode) {
    // Ignore keys like $className, $properties
    // They should be handled within a node itself
    if (nodeKey.startsWith('$')) continue

    let node = parentNode[nodeKey]

    // Item: "./path-to-item"
    if (typeof node === 'string') {
      node = {
        $path: node
      }
    }

    // If we create a node called 'HttpService', but don't give it a path or className
    // then we assume that to be the node name (HttpService in this case)
    if (node.$className === undefined && node.$path === undefined) {
      node.$className = nodeKey
    }

    if (node.$properties) transformProperties(node.$properties)

    // we need to reconcile these paths so that way it all still works
    if (node.$path && node.$path.startsWith('//'))
      node.$path = path.join(relativeRoot, node.$path.replace('//', './'))
    if (node.$path && divergentPaths && !path.isAbsolute(node.$path)) {
      node.$path = path.join(relativePath, node.$path)
    }

    // And now transform the children of this node
    parentNode[nodeKey] = transformNode(
      node,
      projectPath,
      includePath,
      rootPath
    )
  }

  return parentNode
}

module.exports = async (state) => {
  for (const projectName of state.projectNames) {
    // 1. Import project's tree.json files
    const trees = []
    const project = state.index.get(projectName)

    // Include the base tree and project specific tree
    trees.push(transformNode(baseTree, project.path, __dirname, state.root))
    trees.push(
      transformNode(importTree(project), project.path, project.path, state.root)
    )

    // 2. Bring in include's tree.json files
    for (const includeName of project.includes) {
      const include = state.index.get(includeName)
      trees.push(
        transformNode(
          importTree(include),
          project.path,
          include.path,
          state.root
        )
      )
    }

    // 3. Merge the trees and transform them
    const tree = merge({}, ...trees)

    // 4. Include tree into rojo configuration
    const rojoProject =
      importJson(path.resolve(project.path, 'rojo.json')) || {}

    if (!rojoProject.name) rojoProject.name = project.name
    if (rojoProject.tree)
      log.warn(
        `[G011] Project \`${project.name}\`'s rojo.json file has \`tree\` set. Note that this key is overwritten entirely by Gaffer and is ignored.`
      )
    rojoProject.tree = tree

    // 5. Create file
    fs.writeFileSync(
      project.outputs.project,
      JSON.stringify(rojoProject),
      'utf-8'
    )
  }

  return state
}
