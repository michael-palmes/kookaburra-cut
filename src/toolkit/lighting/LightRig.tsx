/** The toolkit's standard three-point-ish light rig: ambient fill + key + rim, matching the constants the lit primitives (`ExtrudedText`, `Ribbon`) bundle; scenes stacking several lit primitives should mount ONE `<LightRig />` and pass `lit={false}` to each, since rigs add up. Static lights only, nothing here reads the clock. */
export function LightRig() {
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 5, 6]} intensity={2.2} />
      <directionalLight position={[-4, 1, -2]} intensity={0.7} />
    </>
  );
}
