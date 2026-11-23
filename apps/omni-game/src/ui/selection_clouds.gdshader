shader_type canvas_item;
render_mode unshaded;
uniform sampler2D cloud_texture : source_color, repeat_enable, filter_linear;
uniform float drift = 0.0;
void fragment() {
 vec4 far_cloud = texture(cloud_texture, vec2(UV.x + drift, UV.y));
 vec4 near_cloud = texture(cloud_texture, vec2(UV.x * 1.35 + drift * 1.45 + 0.48, UV.y * 1.25 - 0.18));
 float alpha = far_cloud.a * 0.48 + near_cloud.a * 0.28 * (1.0 - far_cloud.a * 0.48);
 COLOR = vec4(mix(vec3(0.86, 0.93, 1.0), vec3(1.0, 0.98, 0.91), UV.y), alpha);
}
