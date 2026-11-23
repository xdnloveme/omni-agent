shader_type canvas_item;
render_mode unshaded;

uniform sampler2D cloud_texture : source_color, repeat_enable, filter_linear;
uniform sampler2D visibility_mask : repeat_disable, filter_linear;
uniform float horizontal_tiles : hint_range(1.0, 3.0) = 1.5625;
uniform float horizontal_speed : hint_range(0.0, 0.02) = 0.00833333333;
uniform float vertical_scale : hint_range(1.0, 2.0) = 1.25;
uniform float vertical_offset : hint_range(-0.5, 0.5) = 0.05;
uniform float opacity : hint_range(0.0, 1.0) = 0.72;

void fragment() {
	float cloud_y = clamp(UV.y * vertical_scale + vertical_offset, 0.0, 1.0);
	vec2 cloud_uv = vec2(UV.x * horizontal_tiles + TIME * horizontal_speed, cloud_y);
	vec4 cloud = texture(cloud_texture, cloud_uv);
	float visible_sky = texture(visibility_mask, UV).r;
	COLOR = vec4(cloud.rgb, cloud.a * visible_sky * opacity);
}
