shader_type canvas_item;

// Preserve the authored texture and alpha while bringing its bright orange
// wood into the Workshop's darker, less saturated walnut palette.
void fragment() {
	vec4 source = texture(TEXTURE, UV);
	float luminance = dot(source.rgb, vec3(0.2126, 0.7152, 0.0722));
	vec3 graded = mix(vec3(luminance), source.rgb, 0.65);
	COLOR = vec4(graded, source.a);
}
